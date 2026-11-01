// AUTH-014: backend coverage for the admin-side auth-provider lifecycle:
// list/create/update/delete + the new test-connection action. Hits the real
// mock OIDC IdP for the success case and a bogus issuer for the failure case.

import "./helpers/setupEnv";
import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";

process.env.DATABASE_URL = process.env.DATABASE_URL || "postgresql://test:test@localhost:5432/test";
process.env.PORT = "0";
process.env.AUTH_COOKIE_SECURE = "false";
process.env.AUTH_FLOW_SECRET = "x".repeat(48);

import appDb = require("../src/lib/appDb");
import { createAuthTestStub } from "./helpers/authTestStub";
import { createMockOidcIdp } from "./helpers/mockOidcIdp";
import type { MockOidcIdp } from "./helpers/mockOidcIdp";
import type { ProviderRow } from "../src/services/authProviderService";
import type { ApiSchema, AuthProvider } from "../src/types";
import type { AuthProviderType } from "../src/types/domain";

type AuthProviderListResponse = ApiSchema<"AuthProviderListResponse">;
type AuthProviderTestResult = ApiSchema<"AuthProviderTestResult">;
type AuthProviderResponse = AuthProvider & { provider_config?: Record<string, unknown> };

interface SeedProviderInput {
  id?: string;
  type?: AuthProviderType;
  name: string;
  display_name?: string | null;
  issuer?: string | null;
  client_id?: string | null;
  client_secret?: string | null;
  scopes?: string[] | null;
  redirect_uri?: string | null;
  claims_mapping?: Record<string, unknown> | null;
  enabled?: boolean;
  provider_config?: Record<string, unknown>;
}

interface ErrorPayload {
  message: string;
}

interface CallResult<T> {
  status: number;
  payload: T;
}

let server: import("http").Server;
let baseUrl: string;
let authStub: import("./helpers/authTestStub").AuthTestStub;
let idp: MockOidcIdp;
let issuer: string;
let originalQuery: typeof appDb.query;
let providers: Map<string, ProviderRow>;
let providerCounter: number;
let adminCookie: string;
let analystCookie: string;
let lastInsertedProviderConfig: unknown;

function normalize(sql: string) {
  return String(sql).replace(/\s+/g, " ").trim().toLowerCase();
}

function uuid(prefix: string, counter: number) {
  return `00000000-0000-4000-8000-${prefix}${String(counter).padStart(8, "0")}`;
}

function nextProviderId(): string {
  providerCounter += 1;
  return uuid("eeee", providerCounter);
}

function seedProvider(row: SeedProviderInput): ProviderRow {
  const created: ProviderRow = {
    id: row.id || nextProviderId(),
    type: row.type || "oidc",
    name: row.name,
    display_name: row.display_name ?? null,
    issuer: row.issuer ?? null,
    client_id: row.client_id ?? null,
    client_secret: row.client_secret || null,
    scopes: row.scopes === undefined ? ["openid", "email", "profile"] : row.scopes,
    redirect_uri: row.redirect_uri ?? null,
    claims_mapping: row.claims_mapping === undefined ? {} : row.claims_mapping,
    enabled: row.enabled !== false,
    provider_config: row.provider_config,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString()
  };
  providers.set(created.id, created);
  return created;
}

async function call<T = unknown>(
  method: string,
  path: string,
  { cookie, body }: { cookie?: string; body?: unknown } = {}
): Promise<CallResult<T>> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (cookie) headers.Cookie = cookie;
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined
  });
  let payload: unknown = null;
  if ((response.headers.get("content-type") || "").includes("application/json")) {
    try { payload = await response.json(); } catch { payload = null; }
  }
  return { status: response.status, payload: payload as T };
}

before(async () => {
  authStub = createAuthTestStub();
  idp = await createMockOidcIdp({
    user: { sub: "user-admin", email: "admin@example.com", name: "Admin" },
    clientId: "test-client",
    clientSecret: "test-secret"
  });
  issuer = await idp.start();

  originalQuery = appDb.query;
  providers = new Map();
  providerCounter = 0;

  const admin = authStub.seedUser({ email: "admin@example.com", roles: ["admin"] });
  const analyst = authStub.seedUser({ email: "analyst@example.com", roles: ["analyst"] });
  adminCookie = authStub.cookieFor(authStub.seedSession(admin.id).token);
  analystCookie = authStub.cookieFor(authStub.seedSession(analyst.id).token);

  appDb.query = (async (sql: string, params: unknown[] = []) => {
    const auth = authStub.handleSql(sql, params);
    if (auth) return auth;

    const n = normalize(sql);

    if (n.startsWith("select") && /from auth_providers\s+where id = \$1/.test(n)) {
      const [id] = params as [string];
      const row = providers.get(id);
      return row ? { rowCount: 1, rows: [row] } : { rowCount: 0, rows: [] };
    }

    if (n.startsWith("select") && /from auth_providers\s+order by lower\(name\)/.test(n)) {
      const rows = [...providers.values()].sort((a, b) => a.name.localeCompare(b.name));
      return { rowCount: rows.length, rows };
    }

    if (n.startsWith("insert into auth_providers")) {
      const [type, name, displayName, providerIssuer, clientId, clientSecret, scopes, redirectUri, claimsMappingJson, enabled, providerConfigJson] = params as [
        AuthProviderType,
        string,
        string | null,
        string | null,
        string | null,
        string | null,
        string[] | null,
        string | null,
        string,
        boolean,
        string
      ];
      lastInsertedProviderConfig = JSON.parse(providerConfigJson);
      const existing = [...providers.values()].find((p) => p.name.toLowerCase() === String(name).toLowerCase());
      if (existing) {
        const err = Object.assign(new Error("duplicate name"), { code: "23505" }); throw err;
      }
      const row = seedProvider({
        type, name, display_name: displayName, issuer: providerIssuer, client_id: clientId,
        client_secret: clientSecret, scopes, redirect_uri: redirectUri,
        claims_mapping: JSON.parse(claimsMappingJson) as Record<string, unknown> | null,
        provider_config: JSON.parse(providerConfigJson) as Record<string, unknown>,
        enabled
      });
      return { rowCount: 1, rows: [row] };
    }

    if (n.startsWith("update auth_providers")) {
      const [id, type, name, displayName, providerIssuer, clientId, clientSecret, scopes, redirectUri, claimsMappingJson, enabled, providerConfigSupplied, providerConfigJson] = params as [
        string,
        AuthProviderType,
        string,
        string | null,
        string | null,
        string | null,
        string | null,
        string[] | null,
        string | null,
        string,
        boolean,
        boolean,
        string
      ];
      const existing = providers.get(id);
      if (!existing) return { rowCount: 0, rows: [] };
      const next = {
        ...existing,
        type, name, display_name: displayName, issuer: providerIssuer, client_id: clientId,
        client_secret: clientSecret === null ? existing.client_secret : clientSecret,
        scopes, redirect_uri: redirectUri,
        claims_mapping: JSON.parse(claimsMappingJson) as Record<string, unknown> | null,
        enabled,
        provider_config: providerConfigSupplied ? JSON.parse(providerConfigJson) as Record<string, unknown> : existing.provider_config,
        updated_at: new Date().toISOString()
      };
      providers.set(id, next);
      return { rowCount: 1, rows: [next] };
    }

    if (n.startsWith("delete from auth_providers where id = $1 returning id")) {
      const [id] = params as [string];
      if (!providers.has(id)) return { rowCount: 0, rows: [] };
      providers.delete(id);
      return { rowCount: 1, rows: [{ id }] };
    }

    throw new Error(`Unexpected SQL in admin-providers test stub: ${n}`);
  }) as unknown as typeof appDb.query;

  delete require.cache[require.resolve("../src/server")];
  const { startServer } = require("../src/server");
  server = await startServer();
  baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});

beforeEach(() => {
  providers.clear();
  providerCounter = 0;
  lastInsertedProviderConfig = undefined;
});

after(async () => {
  await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
  await idp.stop();
  appDb.query = originalQuery;
});

test("admin can create, list, update, and delete auth providers; client_secret is redacted", async () => {
  const create = await call<AuthProvider>("POST", "/v1/admin/auth-providers", {
    cookie: adminCookie,
    body: {
      type: "oidc",
      name: "okta",
      display_name: "Okta SSO",
      issuer,
      client_id: idp.clientId,
      client_secret: idp.clientSecret,
      redirect_uri: `${baseUrl}/v1/auth/oidc/callback`
    }
  });
  assert.equal(create.status, 201);
  assert.equal(create.payload.name, "okta");
  assert.equal(create.payload.display_name, "Okta SSO");
  assert.equal(create.payload.client_secret, "***", "client_secret should be redacted in API responses");

  const list = await call<AuthProviderListResponse>("GET", "/v1/admin/auth-providers", { cookie: adminCookie });
  assert.equal(list.status, 200);
  assert.equal(list.payload.items?.length, 1);
  assert.equal(list.payload.items?.[0].client_secret, "***");

  // Updating without client_secret keeps the old one (still redacted in response).
  const update = await call<AuthProvider>("POST", "/v1/admin/auth-providers", {
    cookie: adminCookie,
    body: {
      id: create.payload.id,
      type: "oidc",
      name: "okta",
      display_name: "Okta (prod)",
      issuer,
      client_id: idp.clientId,
      redirect_uri: `${baseUrl}/v1/auth/oidc/callback`
    }
  });
  assert.equal(update.status, 200);
  assert.equal(update.payload.display_name, "Okta (prod)");
  assert.equal(update.payload.client_secret, "***");

  const del = await call("DELETE", `/v1/admin/auth-providers/${create.payload.id}`, { cookie: adminCookie });
  assert.equal(del.status, 200);
});

test("OIDC provider defaults preserve a null omitted display name", async () => {
  const result = await call<AuthProvider>("POST", "/v1/admin/auth-providers", {
    cookie: adminCookie,
    body: {
      type: "oidc",
      name: "okta-default-display",
      issuer,
      client_id: idp.clientId,
      redirect_uri: `${baseUrl}/v1/auth/oidc/callback`
    }
  });

  assert.equal(result.status, 201);
  assert.equal(result.payload.display_name, null);
});

test("auth provider validation surfaces field-level errors", async () => {
  const badIssuer = await call<ErrorPayload>("POST", "/v1/admin/auth-providers", {
    cookie: adminCookie,
    body: {
      type: "oidc",
      name: "bad",
      issuer: "not-a-url",
      client_id: "x",
      redirect_uri: `${baseUrl}/v1/auth/oidc/callback`
    }
  });
  assert.equal(badIssuer.status, 400);
  assert.match(badIssuer.payload.message, /issuer/i);

  const badRedirect = await call<ErrorPayload>("POST", "/v1/admin/auth-providers", {
    cookie: adminCookie,
    body: {
      type: "oidc",
      name: "bad2",
      issuer,
      client_id: "x",
      redirect_uri: "not-a-url"
    }
  });
  assert.equal(badRedirect.status, 400);
  assert.match(badRedirect.payload.message, /redirect_uri/i);

  const badName = await call<ErrorPayload>("POST", "/v1/admin/auth-providers", {
    cookie: adminCookie,
    body: {
      type: "oidc",
      name: "spaces in name",
      issuer,
      client_id: "x",
      redirect_uri: `${baseUrl}/v1/auth/oidc/callback`
    }
  });
  assert.equal(badName.status, 400);
  assert.match(badName.payload.message, /name/i);

  // Duplicate name → 409
  await call("POST", "/v1/admin/auth-providers", {
    cookie: adminCookie,
    body: {
      type: "oidc",
      name: "dup",
      issuer,
      client_id: "x",
      redirect_uri: `${baseUrl}/v1/auth/oidc/callback`
    }
  });
  const dup = await call("POST", "/v1/admin/auth-providers", {
    cookie: adminCookie,
    body: {
      type: "oidc",
      name: "DUP",
      issuer,
      client_id: "x",
      redirect_uri: `${baseUrl}/v1/auth/oidc/callback`
    }
  });
  assert.equal(dup.status, 409);
});

test("admin can create a disabled non-OIDC provider with redacted nested provider config", async () => {
  const providerConfig = {
    token_endpoint: "https://login.example.com/oauth/token",
    token_type: "Bearer",
    token_value: "token-value",
    token_values: ["token-value-a", "token-value-b"],
    api_token_value: "api-token-value",
    refresh_tokens: ["refresh-token-a", "refresh-token-b"],
    api_key: "api-key-value",
    nested: {
      client_secret: "nested-secret",
      display_name: "keep this value",
      accessToken: "nested-token",
      token_value: "nested-token-value",
      access_token_values: ["nested-token-value-a", "nested-token-value-b"],
      api_token_value: "nested-api-token-value",
      refresh_tokens: ["nested-refresh-token"]
    }
  };

  const result = await call<AuthProviderResponse>("POST", "/v1/admin/auth-providers", {
    cookie: adminCookie,
    body: {
      type: "ldap",
      name: "directory",
      provider_config: providerConfig
    }
  });

  assert.equal(result.status, 201);
  assert.equal(result.payload.enabled, false);
  assert.equal(result.payload.issuer, null);
  assert.equal(result.payload.client_id, null);
  assert.equal(result.payload.scopes, null);
  assert.equal(result.payload.redirect_uri, null);
  assert.equal(result.payload.claims_mapping, null);
  assert.deepEqual(lastInsertedProviderConfig, providerConfig);
  assert.deepEqual(result.payload.provider_config, {
    token_endpoint: "https://login.example.com/oauth/token",
    token_type: "Bearer",
    token_value: "***",
    token_values: "***",
    api_token_value: "***",
    refresh_tokens: "***",
    api_key: "***",
    nested: {
      client_secret: "***",
      display_name: "keep this value",
      accessToken: "***",
      token_value: "***",
      access_token_values: "***",
      api_token_value: "***",
      refresh_tokens: "***"
    }
  });

  const update = await call<AuthProviderResponse>("POST", "/v1/admin/auth-providers", {
    cookie: adminCookie,
    body: {
      id: result.payload.id,
      type: "ldap",
      name: "directory"
    }
  });
  assert.equal(update.status, 200);
  assert.deepEqual(update.payload.provider_config, result.payload.provider_config);
});

test("admin rejects explicit activation of an unimplemented provider", async () => {
  const result = await call<ErrorPayload>("POST", "/v1/admin/auth-providers", {
    cookie: adminCookie,
    body: {
      type: "saml",
      name: "saml-disabled",
      enabled: true
    }
  });

  assert.equal(result.status, 400);
  assert.match(result.payload.message, /not implemented|disabled/i);
});

test("POST .../test returns discovery metadata for a reachable provider", async () => {
  const provider = seedProvider({
    name: "okta",
    issuer,
    client_id: idp.clientId,
    client_secret: idp.clientSecret,
    redirect_uri: `${baseUrl}/v1/auth/oidc/callback`
  });

  const result = await call<AuthProviderTestResult>("POST", `/v1/admin/auth-providers/${provider.id}/test`, { cookie: adminCookie });
  assert.equal(result.status, 200);
  assert.equal(result.payload.ok, true);
  assert.equal(result.payload.issuer, issuer);
  assert.ok(result.payload.authorization_endpoint?.startsWith(issuer));
  assert.ok(result.payload.token_endpoint);
  assert.ok(result.payload.jwks_uri);
  assert.ok(Array.isArray(result.payload.code_challenge_methods_supported));
  assert.ok(result.payload.code_challenge_methods_supported.includes("S256"));
});

test("POST .../test reports failure with the error message when discovery fails", async () => {
  const provider = seedProvider({
    name: "broken",
    issuer: "http://127.0.0.1:1/no-such-idp",
    client_id: "x",
    redirect_uri: `${baseUrl}/v1/auth/oidc/callback`
  });

  const result = await call<AuthProviderTestResult>("POST", `/v1/admin/auth-providers/${provider.id}/test`, { cookie: adminCookie });
  assert.equal(result.status, 200);
  assert.equal(result.payload.ok, false);
  assert.ok(typeof result.payload.error === "string" && result.payload.error.length > 0);
});

test("POST .../test rejects an unimplemented provider before OIDC discovery", async () => {
  const provider = seedProvider({
    type: "ldap",
    name: "directory",
    issuer,
    client_id: idp.clientId,
    client_secret: idp.clientSecret,
    redirect_uri: `${baseUrl}/v1/auth/oidc/callback`
  });

  const result = await call<ErrorPayload>("POST", `/v1/admin/auth-providers/${provider.id}/test`, { cookie: adminCookie });
  assert.equal(result.status, 400);
  assert.match(result.payload.message, /not implemented|disabled/i);
});

test("test endpoint is admin-only and 404s for unknown providers", async () => {
  const provider = seedProvider({
    name: "okta",
    issuer,
    client_id: idp.clientId,
    redirect_uri: `${baseUrl}/v1/auth/oidc/callback`
  });

  const analyst = await call("POST", `/v1/admin/auth-providers/${provider.id}/test`, { cookie: analystCookie });
  assert.equal(analyst.status, 403);

  const unauthenticated = await call("POST", `/v1/admin/auth-providers/${provider.id}/test`);
  assert.equal(unauthenticated.status, 401);

  const missing = await call("POST", "/v1/admin/auth-providers/00000000-0000-4000-8000-eeee99999999/test", { cookie: adminCookie });
  assert.equal(missing.status, 404);

  const badId = await call("POST", "/v1/admin/auth-providers/not-a-uuid/test", { cookie: adminCookie });
  assert.equal(badId.status, 400);
});
