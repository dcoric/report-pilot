import { randomBytes } from "crypto";
import type { ProviderRow } from "../authProviderService";
import type { AuthProviderService } from "./index";
import { LdapConnection, ldapPort, parseLdapUrl } from "./ldapClient";
import type { LdapSearchEntryOp } from "./ldapProtocol";

type AdAuthMethod = "ldap_bind" | "kerberos" | "ntlm";

interface AdFlowState {
  readonly provider_id: string;
  readonly state: string;
  readonly type: "ad";
  readonly method: AdAuthMethod;
}

interface AdPrincipal {
  readonly email: string;
  readonly display_name: string | null;
  readonly sub: string | null;
  readonly issuer: string;
  readonly sam_account_name: string | null;
  readonly user_principal_name: string | null;
  readonly claims: Readonly<Record<string, unknown>>;
}

interface AdConnectionTestResult {
  readonly ok: boolean;
  readonly error?: string;
  readonly issuer?: string;
  readonly host?: string;
  readonly port?: number;
  readonly method?: AdAuthMethod;
  readonly bound?: boolean;
  readonly supported_methods?: readonly AdAuthMethod[];
}

interface AdProfile {
  readonly dn: string;
  readonly claims: Readonly<Record<string, unknown>>;
}

interface AdResolveRequest {
  readonly provider: ProviderRow;
  readonly username: string;
  readonly method: AdAuthMethod;
}

const SUPPORTED_METHODS = ["ldap_bind", "kerberos", "ntlm"] as const;
const DEFAULT_USERNAME_ATTRIBUTE = "sAMAccountName";
const DEFAULT_UPN_ATTRIBUTE = "userPrincipalName";
const DEFAULT_EMAIL_ATTRIBUTE = "mail";
const DEFAULT_DISPLAY_NAME_ATTRIBUTE = "displayName";
const DEFAULT_SUB_ATTRIBUTE = "objectGUID";

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

function authMethod(provider: ProviderRow): AdAuthMethod {
  const configured = optionalMappingValue(provider, "auth_method");
  if (!configured) return "ldap_bind";
  switch (configured) {
    case "ldap_bind":
    case "kerberos":
    case "ntlm":
      return configured;
    default:
      throw authError("AD provider auth_method must be one of: ldap_bind, kerberos, ntlm", 400);
  }
}

function firstAttribute(attributes: Readonly<Record<string, readonly string[]>>, name: string): string | null {
  const first = attributes[name]?.[0];
  return typeof first === "string" && first.trim() ? first.trim() : null;
}

function normalizeEmail(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim().toLowerCase() : null;
}

function normalizeString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function deriveBaseDn(provider: ProviderRow): string | null {
  const configured = optionalMappingValue(provider, "base_dn");
  if (configured) return configured;
  const pathBaseDn = new URL(provider.issuer).pathname.replace(/^\//, "");
  if (pathBaseDn) return decodeURIComponent(pathBaseDn);
  const firstDc = provider.client_id.toLowerCase().indexOf("dc=");
  return firstDc >= 0 ? provider.client_id.slice(firstDc) : null;
}

function buildAuthorizeUrl(provider: ProviderRow, state: string, method: AdAuthMethod): string {
  const url = new URL(provider.redirect_uri);
  url.searchParams.set("provider_id", provider.id);
  url.searchParams.set("provider_type", "ad");
  url.searchParams.set("state", state);
  url.searchParams.set("auth_method", method);
  return url.href;
}

function callbackCredential(currentUrl: string, name: string): string {
  const value = new URL(currentUrl).searchParams.get(name);
  if (!value || !value.trim()) throw authError(`AD callback missing ${name}`, 400);
  return value.trim();
}

function ntlmAccountName(value: string): string {
  const separator = value.lastIndexOf("\\");
  return separator >= 0 ? value.slice(separator + 1) : value;
}

function profileFromEntry(entry: LdapSearchEntryOp, provider: ProviderRow): AdProfile {
  const usernameAttribute = mappingValue(provider, "username", DEFAULT_USERNAME_ATTRIBUTE);
  const upnAttribute = mappingValue(provider, "user_principal_name", DEFAULT_UPN_ATTRIBUTE);
  const emailAttribute = mappingValue(provider, "email", DEFAULT_EMAIL_ATTRIBUTE);
  const displayNameAttribute = mappingValue(provider, "display_name", DEFAULT_DISPLAY_NAME_ATTRIBUTE);
  const subAttribute = mappingValue(provider, "sub", DEFAULT_SUB_ATTRIBUTE);
  const claims: Record<string, unknown> = { dn: entry.dn };
  for (const [name, values] of Object.entries(entry.attributes)) {
    claims[name] = values[0] ?? null;
  }
  claims.sam_account_name = firstAttribute(entry.attributes, usernameAttribute);
  claims.user_principal_name = firstAttribute(entry.attributes, upnAttribute);
  claims.email = firstAttribute(entry.attributes, emailAttribute) ?? claims.user_principal_name;
  claims.display_name = firstAttribute(entry.attributes, displayNameAttribute);
  claims.sub = firstAttribute(entry.attributes, subAttribute) ?? entry.dn;
  return { dn: entry.dn, claims };
}

function principalFromClaims(issuer: string, claims: Readonly<Record<string, unknown>>): AdPrincipal {
  const email = normalizeEmail(claims.email ?? claims.mail ?? claims.user_principal_name ?? claims.userPrincipalName);
  if (!email) throw authError("AD response missing mapped email, mail, or userPrincipalName attribute", 400);
  return {
    email,
    display_name: normalizeString(claims.display_name ?? claims.displayName),
    sub: normalizeString(claims.sub ?? claims.object_guid ?? claims.objectGUID ?? claims.objectSid ?? claims.dn),
    issuer,
    sam_account_name: normalizeString(claims.sam_account_name ?? claims.sAMAccountName),
    user_principal_name: normalizeString(claims.user_principal_name ?? claims.userPrincipalName),
    claims
  };
}

export class AdAuthProviderService implements AuthProviderService {
  type = "ad" as const;

  async startLogin(provider: ProviderRow): Promise<{ authorizeUrl: string; flowState: AdFlowState }> {
    if (!provider || !provider.enabled) throw authError("provider is disabled or not found", 404);
    parseLdapUrl(provider);
    const method = authMethod(provider);
    const state = randomBytes(24).toString("base64url");
    return { authorizeUrl: buildAuthorizeUrl(provider, state, method), flowState: { provider_id: provider.id, state, type: "ad", method } };
  }

  async completeLogin(provider: ProviderRow, currentUrl: string, flowState: AdFlowState | null | undefined): Promise<AdPrincipal> {
    if (!provider) throw authError("provider not found", 404);
    if (!flowState || flowState.provider_id !== provider.id || flowState.type !== "ad") throw authError("invalid flow state", 400);
    const callbackUrl = new URL(currentUrl);
    const callbackState = callbackUrl.searchParams.get("state");
    if (callbackState && callbackState !== flowState.state) throw authError("invalid flow state", 400);
    const profile = await this.#authenticate(provider, currentUrl, flowState.method);
    return principalFromClaims(provider.issuer, profile.claims);
  }

  async testConnection(provider: ProviderRow | null | undefined): Promise<AdConnectionTestResult> {
    if (!provider) return { ok: false, error: "provider not found", supported_methods: SUPPORTED_METHODS };
    let connection: LdapConnection | null = null;
    try {
      const url = parseLdapUrl(provider);
      const method = authMethod(provider);
      connection = await LdapConnection.open(provider);
      let bound = false;
      if (provider.client_id || provider.client_secret) {
        await connection.bind(provider.client_id, provider.client_secret ?? "");
        bound = true;
      }
      return { ok: true, issuer: provider.issuer, host: url.hostname, port: ldapPort(url), method, bound, supported_methods: SUPPORTED_METHODS };
    } catch (error) {
      return { ok: false, error: errorMessage(error), supported_methods: SUPPORTED_METHODS };
    } finally {
      connection?.close();
    }
  }

  buildPrincipal(claims: Readonly<Record<string, unknown>>): AdPrincipal {
    return principalFromClaims("ad://local", claims);
  }

  async #authenticate(provider: ProviderRow, currentUrl: string, method: AdAuthMethod): Promise<AdProfile> {
    const username = callbackCredential(currentUrl, "username");
    const password = callbackCredential(currentUrl, "password");
    const connection = await LdapConnection.open(provider);
    try {
      const profile = await this.#resolveProfile(connection, { provider, username, method });
      const bindPrincipal = method === "kerberos" ? normalizeString(profile.claims.user_principal_name) ?? profile.dn : profile.dn;
      await connection.bind(bindPrincipal, password);
      return profile;
    } finally {
      connection.close();
    }
  }

  async #resolveProfile(connection: LdapConnection, request: AdResolveRequest): Promise<AdProfile> {
    const { provider, username, method } = request;
    if (!provider.client_id) throw authError("AD provider requires a service bind DN to search for users", 400);
    await connection.bind(provider.client_id, provider.client_secret ?? "");
    const baseDn = deriveBaseDn(provider);
    if (!baseDn) throw authError("AD provider requires base_dn claims_mapping or a bind DN containing dc=", 400);
    const searchAttribute = method === "kerberos" ? mappingValue(provider, "user_principal_name", DEFAULT_UPN_ATTRIBUTE) : mappingValue(provider, "username", DEFAULT_USERNAME_ATTRIBUTE);
    const searchValue = method === "ntlm" ? ntlmAccountName(username) : username;
    const requestedAttributes = [
      mappingValue(provider, "username", DEFAULT_USERNAME_ATTRIBUTE),
      mappingValue(provider, "user_principal_name", DEFAULT_UPN_ATTRIBUTE),
      mappingValue(provider, "email", DEFAULT_EMAIL_ATTRIBUTE),
      mappingValue(provider, "display_name", DEFAULT_DISPLAY_NAME_ATTRIBUTE),
      mappingValue(provider, "sub", DEFAULT_SUB_ATTRIBUTE),
      "objectSid"
    ];
    const entry = await connection.search(baseDn, searchAttribute, searchValue, requestedAttributes);
    if (!entry) throw authError("AD user not found", 401);
    return profileFromEntry(entry, provider);
  }
}
