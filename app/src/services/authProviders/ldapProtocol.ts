export interface LdapMessage {
  readonly messageId: number;
  readonly protocolOp: LdapProtocolOp;
}

export type LdapProtocolOp = LdapResultOp | LdapSearchEntryOp;

export interface LdapResultOp {
  readonly kind: "result";
  readonly tag: number;
  readonly resultCode: number;
  readonly diagnosticMessage: string;
}

export interface LdapSearchEntryOp {
  readonly kind: "search_entry";
  readonly dn: string;
  readonly attributes: Readonly<Record<string, readonly string[]>>;
}

interface Tlv {
  readonly tag: number;
  readonly value: Buffer;
  readonly nextOffset: number;
}

export const LDAP_BIND_RESPONSE = 0x61;
export const LDAP_SEARCH_ENTRY = 0x64;
export const LDAP_SEARCH_DONE = 0x65;
export const LDAP_SUCCESS = 0;

const LDAP_BIND_REQUEST = 0x60;
const LDAP_SEARCH_REQUEST = 0x63;

export class LdapProtocolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LdapProtocolError";
  }
}

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

function boolean(value: boolean): Buffer {
  return tlv(0x01, Buffer.from([value ? 0xff : 0x00]));
}

function octet(value: string): Buffer {
  return tlv(0x04, Buffer.from(value, "utf8"));
}

function sequence(...parts: readonly Buffer[]): Buffer {
  return tlv(0x30, Buffer.concat(parts));
}

function ldapMessage(messageId: number, operation: Buffer): Buffer {
  return sequence(integer(messageId), operation);
}

function equalityFilter(attribute: string, value: string): Buffer {
  return tlv(0xa3, Buffer.concat([octet(attribute), octet(value)]));
}

export function encodeBindRequest(messageId: number, dn: string, password: string): Buffer {
  return ldapMessage(messageId, tlv(LDAP_BIND_REQUEST, Buffer.concat([integer(3), octet(dn), tlv(0x80, Buffer.from(password, "utf8"))])));
}

export function encodeSearchRequest(
  messageId: number,
  baseDn: string,
  attribute: string,
  value: string,
  requestedAttributes: readonly string[]
): Buffer {
  return ldapMessage(
    messageId,
    tlv(
      LDAP_SEARCH_REQUEST,
      Buffer.concat([
        octet(baseDn),
        enumerated(2),
        enumerated(0),
        integer(1),
        integer(5),
        boolean(false),
        equalityFilter(attribute, value),
        sequence(...requestedAttributes.map(octet))
      ])
    )
  );
}

function readLength(buffer: Buffer, offset: number): { readonly length: number; readonly nextOffset: number } | null {
  const first = buffer[offset];
  if (first === undefined) return null;
  if ((first & 0x80) === 0) return { length: first, nextOffset: offset + 1 };
  const width = first & 0x7f;
  if (buffer.length < offset + 1 + width) return null;
  let length = 0;
  for (let index = 0; index < width; index += 1) {
    const byte = buffer[offset + 1 + index];
    if (byte === undefined) return null;
    length = (length << 8) | byte;
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

function decodeLdapResult(tag: number, value: Buffer): LdapResultOp {
  const resultCode = readTlv(value, 0);
  if (!resultCode || resultCode.tag !== 0x0a) throw new LdapProtocolError("LDAP result missing result code");
  const matchedDn = readTlv(value, resultCode.nextOffset);
  if (!matchedDn) throw new LdapProtocolError("LDAP result missing matched DN");
  const diagnostic = readTlv(value, matchedDn.nextOffset);
  if (!diagnostic) throw new LdapProtocolError("LDAP result missing diagnostic message");
  return { kind: "result", tag, resultCode: readInteger(resultCode.value), diagnosticMessage: diagnostic.value.toString("utf8") };
}

function decodeSearchEntry(value: Buffer): LdapSearchEntryOp {
  const dn = readTlv(value, 0);
  if (!dn) throw new LdapProtocolError("LDAP search entry missing DN");
  const attributes = readTlv(value, dn.nextOffset);
  if (!attributes) throw new LdapProtocolError("LDAP search entry missing attributes");
  const decoded: Record<string, readonly string[]> = {};
  let offset = 0;
  while (offset < attributes.value.length) {
    const attribute = readTlv(attributes.value, offset);
    if (!attribute) throw new LdapProtocolError("LDAP search entry has malformed attribute");
    const name = readTlv(attribute.value, 0);
    if (!name) throw new LdapProtocolError("LDAP search entry attribute missing name");
    const values = readTlv(attribute.value, name.nextOffset);
    if (!values) throw new LdapProtocolError("LDAP search entry attribute missing values");
    const strings: string[] = [];
    let valueOffset = 0;
    while (valueOffset < values.value.length) {
      const attributeValue = readTlv(values.value, valueOffset);
      if (!attributeValue) throw new LdapProtocolError("LDAP search entry attribute has malformed value");
      strings.push(attributeValue.value.toString("utf8"));
      valueOffset = attributeValue.nextOffset;
    }
    decoded[name.value.toString("utf8")] = strings;
    offset = attribute.nextOffset;
  }
  return { kind: "search_entry", dn: dn.value.toString("utf8"), attributes: decoded };
}

export function tryDecodeMessage(buffer: Buffer): { readonly message: LdapMessage; readonly bytesRead: number } | null {
  const outer = readTlv(buffer, 0);
  if (!outer) return null;
  if (outer.tag !== 0x30) throw new LdapProtocolError("LDAP message must be a sequence");
  const messageId = readTlv(outer.value, 0);
  if (!messageId || messageId.tag !== 0x02) throw new LdapProtocolError("LDAP message missing id");
  const operation = readTlv(outer.value, messageId.nextOffset);
  if (!operation) throw new LdapProtocolError("LDAP message missing operation");
  if (operation.tag === LDAP_SEARCH_ENTRY) {
    return { message: { messageId: readInteger(messageId.value), protocolOp: decodeSearchEntry(operation.value) }, bytesRead: outer.nextOffset };
  }
  return {
    message: { messageId: readInteger(messageId.value), protocolOp: decodeLdapResult(operation.tag, operation.value) },
    bytesRead: outer.nextOffset
  };
}
