import * as crypto from "crypto";
import * as http from "http";
import * as https from "https";
import * as zlib from "zlib";
import { URL } from "url";
import type { ProviderRow } from "../authProviderService";
import type { AuthProviderService } from "./index";

const DEFAULT_EMAIL_CLAIM = "email";
const DEFAULT_DISPLAY_NAME_CLAIM = "displayName";
const DEFAULT_SUB_CLAIM = "NameID";
const CLOCK_SKEW_MS = 60_000;
const HTTP_TIMEOUT_MS = 5_000;

interface SamlFlowState {
  readonly provider_id: string;
  readonly type: "saml";
  readonly state: string;
  readonly request_id: string;
  readonly acs_url: string;
}

interface SamlPrincipal {
  readonly email: string;
  readonly display_name: string | null;
  readonly sub: string | null;
  readonly issuer: string;
  readonly claims: Record<string, unknown>;
}

interface SamlConnectionTestResult {
  readonly ok: boolean;
  readonly error?: string;
  readonly issuer?: string;
  readonly sso_url?: string;
  readonly status_code?: number;
}

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

function normalizeEmail(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim().toLowerCase() : null;
}

function normalizeString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function escapeXml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function decodeXml(value: string): string {
  return value
    .replaceAll("&quot;", '"')
    .replaceAll("&apos;", "'")
    .replaceAll("&gt;", ">")
    .replaceAll("&lt;", "<")
    .replaceAll("&amp;", "&");
}

function buildAuthnRequest(provider: ProviderRow, requestId: string): string {
  const issuedAt = new Date().toISOString();
  return `<?xml version="1.0" encoding="UTF-8"?>
<samlp:AuthnRequest xmlns:samlp="urn:oasis:names:tc:SAML:2.0:protocol" xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion" ID="${requestId}" Version="2.0" IssueInstant="${issuedAt}" ProtocolBinding="urn:oasis:names:tc:SAML:2.0:bindings:HTTP-POST" AssertionConsumerServiceURL="${escapeXml(provider.redirect_uri)}">
  <saml:Issuer>${escapeXml(provider.client_id)}</saml:Issuer>
  <samlp:NameIDPolicy Format="urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress" AllowCreate="true" />
</samlp:AuthnRequest>`;
}

function encodeRedirectRequest(xml: string): string {
  return zlib.deflateRawSync(Buffer.from(xml, "utf8")).toString("base64");
}

function xmlAttribute(xml: string, name: string): string | null {
  const match = new RegExp(`\\b${name}="([^"]+)"`).exec(xml);
  return match ? decodeXml(match[1] ?? "") : null;
}

function xmlElement(xml: string, localName: string): string | null {
  const match = new RegExp(`<[^>]*:?${localName}\\b[^>]*>([\\s\\S]*?)</[^>]*:?${localName}>`).exec(xml);
  return match ? decodeXml((match[1] ?? "").trim()) : null;
}

function samlResponseParam(currentUrl: string): string {
  const url = new URL(currentUrl);
  const response = url.searchParams.get("SAMLResponse") ?? new URLSearchParams(url.hash.replace(/^#/, "")).get("SAMLResponse");
  if (!response) throw authError("SAML callback missing SAMLResponse", 400);
  return response;
}

function decodeSamlResponse(encoded: string): string {
  try {
    return Buffer.from(encoded, "base64").toString("utf8");
  } catch (error) {
    throw authError(`SAML response could not be decoded: ${errorMessage(error)}`, 400);
  }
}

function assertTimestampWindow(xml: string): void {
  const now = Date.now();
  for (const [, value] of xml.matchAll(/\bNotBefore="([^"]+)"/g)) {
    const notBefore = Date.parse(value ?? "");
    if (Number.isFinite(notBefore) && now + CLOCK_SKEW_MS < notBefore) throw authError("SAML assertion is not yet valid", 400);
  }
  for (const [, value] of xml.matchAll(/\bNotOnOrAfter="([^"]+)"/g)) {
    const expiresAt = Date.parse(value ?? "");
    if (Number.isFinite(expiresAt) && now - CLOCK_SKEW_MS >= expiresAt) throw authError("SAML assertion has expired", 400);
  }
}

function assertSamlResponse(provider: ProviderRow, flowState: SamlFlowState, xml: string): void {
  if (!xml.includes("urn:oasis:names:tc:SAML:2.0:status:Success")) throw authError("SAML response was not successful", 400);
  const inResponseTo = xmlAttribute(xml, "InResponseTo");
  if (inResponseTo !== flowState.request_id) throw authError("SAML response does not match login request", 400);
  const destination = xmlAttribute(xml, "Destination");
  if (destination && destination !== flowState.acs_url) throw authError("SAML response destination mismatch", 400);
  const recipient = xmlAttribute(xml, "Recipient");
  if (recipient && recipient !== flowState.acs_url) throw authError("SAML subject recipient mismatch", 400);
  const audience = xmlElement(xml, "Audience");
  if (audience && audience !== provider.client_id) throw authError("SAML assertion audience mismatch", 400);
  assertTimestampWindow(xml);
}

function extractAttributes(xml: string): Record<string, unknown> {
  const claims: Record<string, unknown> = {};
  const nameId = xmlElement(xml, "NameID");
  if (nameId) {
    claims.NameID = nameId;
    claims.name_id = nameId;
    claims.sub = nameId;
  }
  const attributePattern = /<[^>]*:?Attribute\b[^>]*\bName="([^"]+)"[^>]*>([\s\S]*?)<\/[^>]*:?Attribute>/g;
  for (const [, rawName, body] of xml.matchAll(attributePattern)) {
    if (!rawName || body === undefined) continue;
    const values = [...body.matchAll(/<[^>]*:?AttributeValue\b[^>]*>([\s\S]*?)<\/[^>]*:?AttributeValue>/g)]
      .map((match) => decodeXml((match[1] ?? "").trim()))
      .filter((value) => value.length > 0);
    if (values.length === 1) claims[decodeXml(rawName)] = values[0];
    if (values.length > 1) claims[decodeXml(rawName)] = values;
  }
  return claims;
}

function issuerFromResponse(xml: string, fallback: string): string {
  return xmlElement(xml, "Issuer") ?? fallback;
}

function principalFromClaims(provider: ProviderRow, issuer: string, claims: Record<string, unknown>): SamlPrincipal {
  const emailClaim = mappingValue(provider, "email", DEFAULT_EMAIL_CLAIM);
  const displayNameClaim = mappingValue(provider, "display_name", DEFAULT_DISPLAY_NAME_CLAIM);
  const subClaim = mappingValue(provider, "sub", DEFAULT_SUB_CLAIM);
  const email = normalizeEmail(claims[emailClaim]);
  if (!email) throw authError(`SAML response missing the '${emailClaim}' claim`, 400);
  return {
    email,
    display_name: normalizeString(claims[displayNameClaim]),
    sub: normalizeString(claims[subClaim]),
    issuer,
    claims
  };
}

function requestUrl(url: URL): Promise<number> {
  return new Promise((resolve, reject) => {
    const client = url.protocol === "https:" ? https : http;
    const req = client.request(url, { method: "GET", timeout: HTTP_TIMEOUT_MS }, (res) => {
      res.resume();
      resolve(res.statusCode ?? 0);
    });
    req.on("timeout", () => req.destroy(new Error("SAML endpoint timed out")));
    req.on("error", reject);
    req.end();
  });
}

export class SamlAuthProviderService implements AuthProviderService {
  type = "saml" as const;

  async startLogin(provider: ProviderRow): Promise<{ authorizeUrl: string; flowState: SamlFlowState }> {
    if (!provider || !provider.enabled) throw authError("provider is disabled or not found", 404);
    const requestId = `_${crypto.randomBytes(16).toString("hex")}`;
    const state = crypto.randomBytes(24).toString("base64url");
    const authorizeUrl = new URL(provider.issuer);
    authorizeUrl.searchParams.set("SAMLRequest", encodeRedirectRequest(buildAuthnRequest(provider, requestId)));
    authorizeUrl.searchParams.set("RelayState", state);
    return { authorizeUrl: authorizeUrl.href, flowState: { provider_id: provider.id, type: "saml", state, request_id: requestId, acs_url: provider.redirect_uri } };
  }

  async completeLogin(provider: ProviderRow, currentUrl: string, flowState: SamlFlowState | null | undefined): Promise<SamlPrincipal> {
    if (!provider) throw authError("provider not found", 404);
    if (!flowState || flowState.provider_id !== provider.id || flowState.type !== "saml") throw authError("invalid flow state", 400);
    const callbackUrl = new URL(currentUrl);
    const relayState = callbackUrl.searchParams.get("RelayState") ?? new URLSearchParams(callbackUrl.hash.replace(/^#/, "")).get("RelayState");
    if (relayState !== flowState.state) throw authError("invalid flow state", 400);
    const responseXml = decodeSamlResponse(samlResponseParam(currentUrl));
    assertSamlResponse(provider, flowState, responseXml);
    const claims = extractAttributes(responseXml);
    return principalFromClaims(provider, issuerFromResponse(responseXml, provider.issuer), claims);
  }

  async testConnection(provider: ProviderRow | null | undefined): Promise<SamlConnectionTestResult> {
    if (!provider) return { ok: false, error: "provider not found" };
    try {
      const ssoUrl = new URL(provider.issuer);
      const statusCode = await requestUrl(ssoUrl);
      return { ok: statusCode >= 200 && statusCode < 400, issuer: provider.issuer, sso_url: ssoUrl.href, status_code: statusCode };
    } catch (error) {
      return { ok: false, error: errorMessage(error) };
    }
  }

  buildPrincipal(claims: Record<string, unknown>): SamlPrincipal {
    const email = normalizeEmail(claims[DEFAULT_EMAIL_CLAIM]);
    if (!email) throw authError(`SAML response missing the '${DEFAULT_EMAIL_CLAIM}' claim`, 400);
    return {
      email,
      display_name: normalizeString(claims[DEFAULT_DISPLAY_NAME_CLAIM]),
      sub: normalizeString(claims[DEFAULT_SUB_CLAIM]),
      issuer: "saml://local",
      claims
    };
  }
}
