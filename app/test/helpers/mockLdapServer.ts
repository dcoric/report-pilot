import { createServer, type Server, type Socket } from "net";

interface LdapUserFixture {
  readonly dn: string;
  readonly password: string;
  readonly attributes: Readonly<Record<string, string>>;
}

interface MockLdapServerOptions {
  readonly serviceDn: string;
  readonly servicePassword: string;
  readonly usernameAttribute: string;
  readonly user: LdapUserFixture;
}

interface LdapRequest {
  readonly messageId: number;
  readonly operationTag: number;
  readonly operation: Buffer;
}

interface BindRequest {
  readonly dn: string;
  readonly password: string;
}

interface SearchRequest {
  readonly attribute: string;
  readonly value: string;
}

interface Tlv {
  readonly tag: number;
  readonly value: Buffer;
  readonly nextOffset: number;
}

const LDAP_BIND_REQUEST = 0x60;
const LDAP_BIND_RESPONSE = 0x61;
const LDAP_SEARCH_REQUEST = 0x63;
const LDAP_SEARCH_ENTRY = 0x64;
const LDAP_SEARCH_DONE = 0x65;
const LDAP_SUCCESS = 0;
const LDAP_INVALID_CREDENTIALS = 49;

function encodeLength(length: number): Buffer {
  if (length < 0x80) return Buffer.from([length]);
  const bytes: number[] = [];
  let remaining = length;
  while (remaining > 0) {
    bytes.unshift(remaining & 0xff);
    remaining >>= 8;
  }
  return Buffer.from([0x80 | bytes.length, ...bytes]);
}

function tlv(tag: number, value: Buffer): Buffer {
  return Buffer.concat([Buffer.from([tag]), encodeLength(value.length), value]);
}

function integer(value: number): Buffer {
  return tlv(0x02, Buffer.from([value]));
}

function enumerated(value: number): Buffer {
  return tlv(0x0a, Buffer.from([value]));
}

function octet(value: string): Buffer {
  return tlv(0x04, Buffer.from(value, "utf8"));
}

function sequence(...parts: readonly Buffer[]): Buffer {
  return tlv(0x30, Buffer.concat(parts));
}

function set(...parts: readonly Buffer[]): Buffer {
  return tlv(0x31, Buffer.concat(parts));
}

function readLength(buffer: Buffer, offset: number): { readonly length: number; readonly nextOffset: number } | null {
  const first = buffer[offset];
  if (first === undefined) return null;
  if ((first & 0x80) === 0) return { length: first, nextOffset: offset + 1 };
  const width = first & 0x7f;
  if (buffer.length < offset + 1 + width) return null;
  let length = 0;
  for (let index = 0; index < width; index += 1) {
    length = (length << 8) | buffer[offset + 1 + index];
  }
  return { length, nextOffset: offset + 1 + width };
}

function readTlv(buffer: Buffer, offset: number): Tlv | null {
  const tag = buffer[offset];
  if (tag === undefined) return null;
  const length = readLength(buffer, offset + 1);
  if (!length) return null;
  const end = length.nextOffset + length.length;
  if (buffer.length < end) return null;
  return { tag, value: buffer.subarray(length.nextOffset, end), nextOffset: end };
}

function readInteger(buffer: Buffer): number {
  return buffer.reduce((value, byte) => (value << 8) | byte, 0);
}

function parseMessage(buffer: Buffer): LdapRequest | null {
  const outer = readTlv(buffer, 0);
  if (!outer || outer.tag !== 0x30) return null;
  const messageId = readTlv(outer.value, 0);
  if (!messageId || messageId.tag !== 0x02) return null;
  const operation = readTlv(outer.value, messageId.nextOffset);
  if (!operation) return null;
  return { messageId: readInteger(messageId.value), operationTag: operation.tag, operation: operation.value };
}

function parseBindRequest(operation: Buffer): BindRequest | null {
  const version = readTlv(operation, 0);
  if (!version) return null;
  const dn = readTlv(operation, version.nextOffset);
  if (!dn) return null;
  const password = readTlv(operation, dn.nextOffset);
  if (!password || password.tag !== 0x80) return null;
  return { dn: dn.value.toString("utf8"), password: password.value.toString("utf8") };
}

function findEqualityFilter(buffer: Buffer): SearchRequest | null {
  const equality = readTlv(buffer, 0);
  if (!equality) return null;
  if (equality.tag === 0xa3) {
    const attribute = readTlv(equality.value, 0);
    if (!attribute) return null;
    const value = readTlv(equality.value, attribute.nextOffset);
    if (!value) return null;
    return { attribute: attribute.value.toString("utf8"), value: value.value.toString("utf8") };
  }
  return findEqualityFilter(equality.value);
}

function parseSearchRequest(operation: Buffer): SearchRequest | null {
  let offset = 0;
  for (let field = 0; field < 6; field += 1) {
    const tlvField = readTlv(operation, offset);
    if (!tlvField) return null;
    offset = tlvField.nextOffset;
  }
  return findEqualityFilter(operation.subarray(offset));
}

function ldapResult(messageId: number, responseTag: number, resultCode: number): Buffer {
  return sequence(
    integer(messageId),
    tlv(responseTag, Buffer.concat([enumerated(resultCode), octet(""), octet("")]))
  );
}

function searchEntry(messageId: number, user: LdapUserFixture): Buffer {
  const attributes = Object.entries(user.attributes).map(([name, value]) => sequence(octet(name), set(octet(value))));
  return sequence(integer(messageId), tlv(LDAP_SEARCH_ENTRY, Buffer.concat([octet(user.dn), sequence(...attributes)])));
}

class MockLdapServer {
  readonly #server: Server;
  readonly #options: MockLdapServerOptions;

  constructor(options: MockLdapServerOptions) {
    this.#options = options;
    this.#server = createServer((socket) => this.#handleSocket(socket));
  }

  async start(): Promise<string> {
    await new Promise<void>((resolve, reject) => {
      this.#server.once("error", reject);
      this.#server.listen(0, "127.0.0.1", () => {
        this.#server.off("error", reject);
        resolve();
      });
    });
    const address = this.#server.address();
    if (!address || typeof address === "string") throw new Error("mock LDAP server did not bind to TCP");
    return `ldap://127.0.0.1:${address.port}`;
  }

  async stop(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      this.#server.close((error) => (error ? reject(error) : resolve()));
    });
  }

  #handleSocket(socket: Socket): void {
    socket.on("data", (data) => {
      const request = parseMessage(Buffer.isBuffer(data) ? data : Buffer.from(data));
      if (!request) {
        socket.destroy();
        return;
      }
      if (request.operationTag === LDAP_BIND_REQUEST) {
        this.#handleBind(socket, request);
        return;
      }
      if (request.operationTag === LDAP_SEARCH_REQUEST) {
        this.#handleSearch(socket, request);
      }
    });
  }

  #handleBind(socket: Socket, request: LdapRequest): void {
    const bind = parseBindRequest(request.operation);
    const serviceMatch = bind?.dn === this.#options.serviceDn && bind.password === this.#options.servicePassword;
    const userMatch = bind?.dn === this.#options.user.dn && bind.password === this.#options.user.password;
    const code = serviceMatch || userMatch ? LDAP_SUCCESS : LDAP_INVALID_CREDENTIALS;
    socket.write(ldapResult(request.messageId, LDAP_BIND_RESPONSE, code));
  }

  #handleSearch(socket: Socket, request: LdapRequest): void {
    const search = parseSearchRequest(request.operation);
    const username = this.#options.user.attributes[this.#options.usernameAttribute];
    if (search?.attribute === this.#options.usernameAttribute && search.value === username) {
      socket.write(searchEntry(request.messageId, this.#options.user));
    }
    socket.write(ldapResult(request.messageId, LDAP_SEARCH_DONE, LDAP_SUCCESS));
  }
}

export function createMockLdapServer(options: MockLdapServerOptions): MockLdapServer {
  return new MockLdapServer(options);
}
