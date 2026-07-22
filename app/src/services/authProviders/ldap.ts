import { randomBytes } from "crypto";
import type { ProviderRow } from "../authProviderService";
import type { AuthProviderService } from "./index";
import { LdapConnection, ldapPort, parseLdapUrl } from "./ldapClient";
import type { LdapSearchEntryOp } from "./ldapProtocol";

interface LdapFlowState {
  readonly provider_id: string;
  readonly state: string;
  readonly type: "ldap";
}

interface LdapPrincipal {
  readonly email: string;
  readonly display_name: string | null;
  readonly sub: string | null;
  readonly issuer: string;
  readonly claims: Readonly<Record<string, unknown>>;
}

interface LdapConnectionTestResult {
  readonly ok: boolean;
  readonly error?: string;
  readonly issuer?: string;
  readonly host?: string;
  readonly port?: number;
  readonly bound?: boolean;
}

interface LdapProfile {
  readonly dn: string;
  readonly claims: Readonly<Record<string, unknown>>;
}

const DEFAULT_EMAIL_ATTRIBUTE = "mail";
const DEFAULT_DISPLAY_NAME_ATTRIBUTE = "cn";
const DEFAULT_SUB_ATTRIBUTE = "dn";
const DEFAULT_USERNAME_ATTRIBUTE = "uid";

function authError(message: string, statusCode: number): Error & { readonly statusCode: number } {
  return Object.assign(new Error(message), { statusCode });
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function mappingValue(provider: ProviderRow, key: string, fallback: string): string {
  const value = provider.claims_mapping?.[key];
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
}

function optionalMappingValue(provider: ProviderRow, key: string): string | null {
  const value = provider.claims_mapping?.[key];
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function firstAttribute(attributes: Readonly<Record<string, readonly string[]>>, name: string): string | null {
  const values = attributes[name];
  const first = values?.[0];
  return typeof first === "string" && first.trim() ? first.trim() : null;
}

function normalizeEmail(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim().toLowerCase() : null;
}

function normalizeString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function looksLikeDn(value: string): boolean {
  return /^[a-z][a-z0-9-]*=/i.test(value) && value.includes(",");
}

function deriveBaseDn(provider: ProviderRow): string | null {
  const configured = optionalMappingValue(provider, "base_dn");
  if (configured) return configured;
  const bindDn = provider.client_id;
  const firstDc = bindDn.toLowerCase().indexOf("dc=");
  return firstDc >= 0 ? bindDn.slice(firstDc) : null;
}

function buildAuthorizeUrl(provider: ProviderRow, state: string): string {
  const url = new URL(provider.redirect_uri);
  url.searchParams.set("provider_id", provider.id);
  url.searchParams.set("state", state);
  url.searchParams.set("provider_type", "ldap");
  return url.href;
}

function callbackCredential(currentUrl: string, name: string): string {
  const value = new URL(currentUrl).searchParams.get(name);
  if (!value || !value.trim()) throw authError(`LDAP callback missing ${name}`, 400);
  return value.trim();
}

function profileFromEntry(entry: LdapSearchEntryOp, provider: ProviderRow): LdapProfile {
  const emailAttribute = mappingValue(provider, "email", DEFAULT_EMAIL_ATTRIBUTE);
  const displayNameAttribute = mappingValue(provider, "display_name", DEFAULT_DISPLAY_NAME_ATTRIBUTE);
  const subAttribute = mappingValue(provider, "sub", DEFAULT_SUB_ATTRIBUTE);
  const claims: Record<string, unknown> = { dn: entry.dn };
  for (const [name, values] of Object.entries(entry.attributes)) {
    claims[name] = values[0] ?? null;
  }
  claims.email = firstAttribute(entry.attributes, emailAttribute);
  claims.display_name = firstAttribute(entry.attributes, displayNameAttribute);
  claims.sub = subAttribute === DEFAULT_SUB_ATTRIBUTE ? entry.dn : firstAttribute(entry.attributes, subAttribute);
  return { dn: entry.dn, claims };
}

function principalFromClaims(issuer: string, claims: Readonly<Record<string, unknown>>): LdapPrincipal {
  const email = normalizeEmail(claims.email ?? claims[DEFAULT_EMAIL_ATTRIBUTE]);
  if (!email) throw authError("LDAP response missing mapped email attribute", 400);
  return {
    email,
    display_name: normalizeString(claims.display_name ?? claims[DEFAULT_DISPLAY_NAME_ATTRIBUTE]),
    sub: normalizeString(claims.sub ?? claims.dn),
    issuer,
    claims
  };
}

export class LdapAuthProviderService implements AuthProviderService {
  type = "ldap" as const;

  async startLogin(provider: ProviderRow): Promise<{ authorizeUrl: string; flowState: LdapFlowState }> {
    if (!provider || !provider.enabled) throw authError("provider is disabled or not found", 404);
    parseLdapUrl(provider);
    const state = randomBytes(24).toString("base64url");
    return { authorizeUrl: buildAuthorizeUrl(provider, state), flowState: { provider_id: provider.id, state, type: "ldap" } };
  }

  async completeLogin(provider: ProviderRow, currentUrl: string, flowState: LdapFlowState | null | undefined): Promise<LdapPrincipal> {
    if (!provider) throw authError("provider not found", 404);
    if (!flowState || flowState.provider_id !== provider.id || flowState.type !== "ldap") throw authError("invalid flow state", 400);
    const callbackUrl = new URL(currentUrl);
    const callbackState = callbackUrl.searchParams.get("state");
    if (callbackState && callbackState !== flowState.state) throw authError("invalid flow state", 400);
    const username = callbackCredential(currentUrl, "username");
    const password = callbackCredential(currentUrl, "password");
    const profile = await this.#authenticate(provider, username, password);
    return principalFromClaims(provider.issuer, profile.claims);
  }

  async testConnection(provider: ProviderRow | null | undefined): Promise<LdapConnectionTestResult> {
    if (!provider) return { ok: false, error: "provider not found" };
	let connection: LdapConnection | null = null;
	try {
	  const url = parseLdapUrl(provider);
      connection = await LdapConnection.open(provider);
      let bound = false;
      if (provider.client_id || provider.client_secret) {
        await connection.bind(provider.client_id, provider.client_secret ?? "");
        bound = true;
      }
      return { ok: true, issuer: provider.issuer, host: url.hostname, port: ldapPort(url), bound };
    } catch (error) {
      return { ok: false, error: errorMessage(error) };
    } finally {
      connection?.close();
    }
  }

  buildPrincipal(claims: Readonly<Record<string, unknown>>): LdapPrincipal {
    return principalFromClaims("ldap://local", claims);
  }

  async #authenticate(provider: ProviderRow, username: string, password: string): Promise<LdapProfile> {
    const connection = await LdapConnection.open(provider);
    try {
      const profile = await this.#resolveProfile(connection, provider, username);
      await connection.bind(profile.dn, password);
      return profile;
    } finally {
      connection.close();
    }
  }

  async #resolveProfile(connection: LdapConnection, provider: ProviderRow, username: string): Promise<LdapProfile> {
    const template = optionalMappingValue(provider, "user_dn_template");
    if (template) return { dn: template.replaceAll("{username}", username), claims: { username, dn: template.replaceAll("{username}", username) } };
    if (looksLikeDn(username)) return { dn: username, claims: { username, dn: username } };
    if (!provider.client_id) throw authError("LDAP provider requires a service bind DN to search for users", 400);
    await connection.bind(provider.client_id, provider.client_secret ?? "");
    const baseDn = deriveBaseDn(provider);
    if (!baseDn) throw authError("LDAP provider requires base_dn claims_mapping to search for users", 400);
    const usernameAttribute = mappingValue(provider, "username", DEFAULT_USERNAME_ATTRIBUTE);
    const attributes = [
      usernameAttribute,
      mappingValue(provider, "email", DEFAULT_EMAIL_ATTRIBUTE),
      mappingValue(provider, "display_name", DEFAULT_DISPLAY_NAME_ATTRIBUTE),
      mappingValue(provider, "sub", DEFAULT_SUB_ATTRIBUTE)
    ];
    const entry = await connection.search(baseDn, usernameAttribute, username, attributes);
    if (!entry) throw authError("LDAP user not found", 401);
    return profileFromEntry(entry, provider);
  }
}
