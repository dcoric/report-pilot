import { connect as connectTcp, type Socket } from "net";
import { connect as connectTls } from "tls";
import type { ProviderRow } from "../authProviderService";
import {
  LDAP_BIND_RESPONSE,
  LDAP_SEARCH_DONE,
  LDAP_SUCCESS,
  encodeBindRequest,
  encodeSearchRequest,
  tryDecodeMessage,
  type LdapMessage,
  type LdapSearchEntryOp
} from "./ldapProtocol";

const LDAP_TIMEOUT_MS = 5_000;

function authError(message: string, statusCode: number): Error & { readonly statusCode: number } {
  return Object.assign(new Error(message), { statusCode });
}

export function parseLdapUrl(provider: ProviderRow): URL {
  const url = new URL(provider.issuer);
  if (url.protocol !== "ldap:" && url.protocol !== "ldaps:") {
    throw authError("LDAP provider issuer must use ldap:// or ldaps://", 400);
  }
  return url;
}

export function ldapPort(url: URL): number {
  return Number(url.port || (url.protocol === "ldaps:" ? 636 : 389));
}

export class LdapConnection {
  readonly #socket: Socket;
  #buffer = Buffer.alloc(0);
  #messageId = 0;

  private constructor(socket: Socket) {
    this.#socket = socket;
    this.#socket.setTimeout(LDAP_TIMEOUT_MS);
  }

  static async open(provider: ProviderRow): Promise<LdapConnection> {
    const url = parseLdapUrl(provider);
    const port = ldapPort(url);
    const host = url.hostname;
    const socket = await new Promise<Socket>((resolve, reject) => {
      const created = url.protocol === "ldaps:" ? connectTls({ host, port }) : connectTcp({ host, port });
      created.once("connect", () => resolve(created));
      created.once("secureConnect", () => resolve(created));
      created.once("error", reject);
      created.setTimeout(LDAP_TIMEOUT_MS, () => created.destroy(new Error("LDAP connection timed out")));
    });
    return new LdapConnection(socket);
  }

  async bind(dn: string, password: string): Promise<void> {
    const message = await this.#send(encodeBindRequest(this.#nextMessageId(), dn, password), LDAP_BIND_RESPONSE);
    const result = message.protocolOp;
    if (result.kind !== "result" || result.resultCode !== LDAP_SUCCESS) {
      throw authError(result.kind === "result" && result.diagnosticMessage ? result.diagnosticMessage : "LDAP bind failed", 401);
    }
  }

  async search(baseDn: string, attribute: string, value: string, requestedAttributes: readonly string[]): Promise<LdapSearchEntryOp | null> {
    const messageId = this.#nextMessageId();
    this.#socket.write(encodeSearchRequest(messageId, baseDn, attribute, value, requestedAttributes));
    let found: LdapSearchEntryOp | null = null;
    while (true) {
      const message = await this.#readMessage(messageId);
      const operation = message.protocolOp;
      if (operation.kind === "search_entry") found = operation;
      if (operation.kind === "result" && operation.tag === LDAP_SEARCH_DONE) {
        if (operation.resultCode !== LDAP_SUCCESS) throw authError(operation.diagnosticMessage || "LDAP search failed", 400);
        return found;
      }
    }
  }

  close(): void {
    this.#socket.destroy();
  }

  #nextMessageId(): number {
    this.#messageId += 1;
    return this.#messageId;
  }

  async #send(payload: Buffer, expectedTag: number): Promise<LdapMessage> {
    const messageId = this.#messageId;
    this.#socket.write(payload);
    const message = await this.#readMessage(messageId);
    const operation = message.protocolOp;
    if (operation.kind === "result" && operation.tag === expectedTag) return message;
    throw authError("LDAP server returned an unexpected response", 400);
  }

  async #readMessage(messageId: number): Promise<LdapMessage> {
    while (true) {
      const decoded = tryDecodeMessage(this.#buffer);
      if (decoded) {
        this.#buffer = this.#buffer.subarray(decoded.bytesRead);
        if (decoded.message.messageId === messageId) return decoded.message;
      }
      await this.#readChunk();
    }
  }

  async #readChunk(): Promise<void> {
    const chunk = await new Promise<Buffer>((resolve, reject) => {
      this.#socket.once("data", resolve);
      this.#socket.once("error", reject);
      this.#socket.once("timeout", () => reject(new Error("LDAP operation timed out")));
      this.#socket.once("close", () => reject(new Error("LDAP connection closed")));
    });
    this.#buffer = Buffer.concat([this.#buffer, chunk]);
  }
}
