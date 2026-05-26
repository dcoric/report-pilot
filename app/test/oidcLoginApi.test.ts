// AUTH-010 end-to-end: a real (in-process) OIDC IdP, the app's
// /v1/auth/oidc/login → IdP /authorize → /v1/auth/oidc/callback flow,
// and the post-login session sanity-check via /v1/auth/me.

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

let server: import("http").Server;
let baseUrl: string;
let authStub: import("./helpers/authTestStub").AuthTestStub;
let idp;
let originalQuery: typeof appDb.query;
let providers; // in-memory provider rows
let providerCounter;
let aliceUserId;

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

function seedProvider(row) {
  const created = {
    id: row.id || nextProviderId(),
    type: row.type || "oidc",
    name: row.name,
    display_name: row.display_name || null,
    issuer: row.issuer,
    client_id: row.client_id,
    client_secret: row.client_secret || null,
    scopes: row.scopes || ["openid", "email", "profile"],
    redirect_uri: row.redirect_uri,
    claims_mapping: row.claims_mapping || {},
    enabled: row.enabled !== false,
    // AUTH-012 defaults — match the migration so providers seeded in tests
    // behave like production rows (auto-link on by default, JIT off).
    auto_link_by_email: row.auto_link_by_email !== undefined ? row.auto_link_by_email : true,
    jit_enabled: row.jit_enabled === true,
    jit_default_role: row.jit_default_role || "viewer",
    jit_allowed_domains: row.jit_allowed_domains || [],
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString()
  };
  providers.set(created.id, created);
  return created;
}

type FetchRedirect = "manual" | "follow" | "error";

async function call(method: string, path: string, { cookie, body, redirect = "manual" }: { cookie?: string; body?: unknown; redirect?: FetchRedirect } = {}) {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (cookie) headers.Cookie = cookie;
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers,
    redirect,
    body: body ? JSON.stringify(body) : undefined
  });
  let payload = null;
  if ((response.headers.get("content-type") || "").includes("application/json")) {
    try { payload = await response.json(); } catch { payload = null; }
  }
  return {
    status: response.status,
    payload,
    headers: response.headers,
    location: response.headers.get("location"),
    setCookie: response.headers.getSetCookie ? response.headers.getSetCookie() : (response.headers.get("set-cookie") ? [response.headers.get("set-cookie")] : [])
  };
}

function pickCookie(setCookies, name) {
  for (const sc of setCookies) {
    const match = sc.match(new RegExp(`(^|;\\s*)${name}=([^;]*)`));
    if (match) return `${name}=${match[2]}`;
  }
  return null;
}

before(async () => {
  authStub = createAuthTestStub();
  idp = await createMockOidcIdp({
    user: { sub: "user-alice", email: "alice@example.com", name: "Alice" },
    clientId: "test-client",
    clientSecret: "test-secret"
  });
  await idp.start();

  originalQuery = appDb.query;
  providers = new Map();
  providerCounter = 0;

  const alice = authStub.seedUser({
    email: "alice@example.com",
    roles: ["analyst"]
  });
  aliceUserId = alice.id;

  appDb.query = (async (sql: string, params: unknown[] = []) => {
    const auth = authStub.handleSql(sql, params);
    if (auth) return auth;

    const n = normalize(sql);

    // authService.findUserByEmail (lookup after callback)
    if (n.startsWith("select id, email, password_hash, display_name, is_active, last_login_at, created_at, updated_at from users where lower(email) = $1")) {
      const [emailLower] = params;
      if (emailLower === "alice@example.com") {
        return {
          rowCount: 1,
          rows: [{
            id: aliceUserId,
            email: "alice@example.com",
            password_hash: null,
            display_name: null,
            is_active: true,
            last_login_at: null,
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString()
          }]
        };
      }
      return { rowCount: 0, rows: [] };
    }

    // authProviderService queries
    if (n.startsWith("select") && /from auth_providers\s+where id = \$1/.test(n)) {
      const [id] = params;
      const row = providers.get(id);
      return row ? { rowCount: 1, rows: [row] } : { rowCount: 0, rows: [] };
    }

    if (n.startsWith("select id, name, display_name, type from auth_providers where enabled = true")) {
      const rows = [...providers.values()].filter((p) => p.enabled).map((p) => ({
        id: p.id,
        name: p.name,
        display_name: p.display_name,
        type: p.type
      }));
      return { rowCount: rows.length, rows };
    }

    if (n.startsWith("select") && /from auth_providers\s+order by lower\(name\)/.test(n)) {
      const rows = [...providers.values()].sort((a, b) => a.name.localeCompare(b.name));
      return { rowCount: rows.length, rows };
    }

    if (n.startsWith("insert into auth_providers")) {
      const [type, name, displayName, issuer, clientId, clientSecret, scopes, redirectUri, claimsMappingJson, enabled] = params;
      const existing = [...providers.values()].find((p) => p.name.toLowerCase() === String(name).toLowerCase());
      if (existing) {
        const err = Object.assign(new Error("duplicate name"), { code: "23505" }); throw err;
      }
      const row = seedProvider({
        type, name, display_name: displayName, issuer, client_id: clientId,
        client_secret: clientSecret, scopes, redirect_uri: redirectUri,
        claims_mapping: JSON.parse(claimsMappingJson as string), enabled
      });
      return { rowCount: 1, rows: [row] };
    }

    if (n.startsWith("update auth_providers")) {
      const [id, type, name, displayName, issuer, clientId, clientSecret, scopes, redirectUri, claimsMappingJson, enabled] = params;
      const existing = providers.get(id);
      if (!existing) return { rowCount: 0, rows: [] };
      const next = {
        ...existing,
        type,
        name,
        display_name: displayName,
        issuer,
        client_id: clientId,
        client_secret: clientSecret === null ? existing.client_secret : clientSecret,
        scopes,
        redirect_uri: redirectUri,
        claims_mapping: JSON.parse(claimsMappingJson as string),
        enabled,
        updated_at: new Date().toISOString()
      };
      providers.set(id, next);
      return { rowCount: 1, rows: [next] };
    }

    if (n.startsWith("delete from auth_providers where id = $1 returning id")) {
      const [id] = params;
      if (!providers.has(id)) return { rowCount: 0, rows: [] };
      providers.delete(id);
      return { rowCount: 1, rows: [{ id }] };
    }

    // AUTH-012: linked_identities lookups exercised by externalLoginService.
    // In this suite we never pre-seed links, so the lookup always misses; the
    // INSERT is a no-op for assertions (we only care that the route succeeds).
    if (n.startsWith("select") && /from linked_identities\s+where provider_id = \$1 and subject = \$2/.test(n)) {
      return { rowCount: 0, rows: [] };
    }
    if (n.startsWith("insert into linked_identities")) {
      return { rowCount: 1, rows: [{ id: "00000000-0000-4000-8000-ffff00000001" }] };
    }
    if (n.startsWith("update linked_identities set last_seen_at = now() where id = $1")) {
      return { rowCount: 1, rows: [] };
    }
    // AUTH-015: state replay protection. Tests in this file always present
    // a fresh state, so the insert succeeds; the dedicated replay coverage
    // lives in federationHardeningApi.test.js.
    if (n.startsWith("insert into oidc_used_states")) {
      return { rowCount: 1, rows: [] };
    }
    if (n.startsWith("delete from oidc_used_states")) {
      return { rowCount: 0, rows: [] };
    }
    // Audit writes from the resolver are .catch'd by callers, so failure is
    // tolerable — but returning an empty result keeps the logs clean.
    if (n.startsWith("insert into auth_audit_log")) {
      return { rowCount: 1, rows: [] };
    }

    throw new Error(`Unexpected SQL in OIDC test stub: ${n}`);
  }) as unknown as typeof appDb.query;

  delete require.cache[require.resolve("../src/server")];
  const { startServer } = require("../src/server");
  server = await startServer();
  baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});

beforeEach(() => {
  providers.clear();
  providerCounter = 0;
});

after(async () => {
  await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
  await idp.stop();
  appDb.query = originalQuery;
});

test("GET /v1/auth/oidc/providers exposes only enabled providers, no secrets", async () => {
  const provider = seedProvider({
    name: "okta",
    display_name: "Okta SSO",
    issuer: idp.issuer,
    client_id: idp.clientId,
    client_secret: idp.clientSecret,
    redirect_uri: `${baseUrl}/v1/auth/oidc/callback`,
    enabled: true
  });
  seedProvider({
    name: "disabled",
    display_name: "Disabled",
    issuer: idp.issuer,
    client_id: "x",
    client_secret: "y",
    redirect_uri: `${baseUrl}/v1/auth/oidc/callback`,
    enabled: false
  });

  const result = await call("GET", "/v1/auth/oidc/providers");
  assert.equal(result.status, 200);
  assert.equal(result.payload.items.length, 1);
  const item = result.payload.items[0];
  assert.equal(item.id, provider.id);
  assert.equal(item.display_name, "Okta SSO");
  assert.equal("client_secret" in item, false);
});

test("OIDC login flow: start → IdP authorize → callback → session cookie", async () => {
  const provider = seedProvider({
    name: "okta",
    display_name: "Okta",
    issuer: idp.issuer,
    client_id: idp.clientId,
    client_secret: idp.clientSecret,
    redirect_uri: `${baseUrl}/v1/auth/oidc/callback`,
    enabled: true
  });

  // 1. Start the flow.
  const start = await call("GET", `/v1/auth/oidc/login?provider_id=${provider.id}`);
  assert.equal(start.status, 302);
  assert.ok(start.location && start.location.startsWith(`${idp.issuer}/authorize`));
  const flowCookie = pickCookie(start.setCookie, "rp_oidc_flow");
  assert.ok(flowCookie, "expected rp_oidc_flow cookie to be set");

  // 2. Hit the IdP's authorize endpoint directly (no cookie needed — it's another server).
  const idpRedirect = await fetch(start.location, { redirect: "manual" });
  assert.equal(idpRedirect.status, 302);
  const callbackUrl = new URL(idpRedirect.headers.get("location"));
  assert.equal(callbackUrl.pathname, "/v1/auth/oidc/callback");
  assert.ok(callbackUrl.searchParams.get("code"));
  assert.ok(callbackUrl.searchParams.get("state"));

  // 3. Hand the callback back to our app, carrying the flow cookie.
  const callback = await call(
    "GET",
    `${callbackUrl.pathname}${callbackUrl.search}`,
    { cookie: flowCookie }
  );
  assert.equal(callback.status, 302);
  assert.equal(callback.location, "/dashboard");
  const sessionCookie = pickCookie(callback.setCookie, "rp_session");
  assert.ok(sessionCookie, "expected rp_session to be set after successful callback");
  const clearFlow = callback.setCookie.find((c) => /rp_oidc_flow=;/.test(c) || /Max-Age=0/.test(c));
  assert.ok(clearFlow, "expected rp_oidc_flow cookie to be cleared");

  // 4. /v1/auth/me works with the new session.
  const me = await call("GET", "/v1/auth/me", { cookie: sessionCookie });
  assert.equal(me.status, 200);
  assert.equal(me.payload.user.email, "alice@example.com");
  assert.deepEqual(me.payload.user.roles, ["analyst"]);
});

test("OIDC callback returns 403 when the IdP email has no local user", async () => {
  const provider = seedProvider({
    name: "okta",
    display_name: "Okta",
    issuer: idp.issuer,
    client_id: idp.clientId,
    client_secret: idp.clientSecret,
    redirect_uri: `${baseUrl}/v1/auth/oidc/callback`,
    enabled: true
  });

  idp.updateUser({ email: "stranger@example.com", name: "Stranger", sub: "user-stranger" });
  try {
    const start = await call("GET", `/v1/auth/oidc/login?provider_id=${provider.id}`);
    const flowCookie = pickCookie(start.setCookie, "rp_oidc_flow");
    const idpRedirect = await fetch(start.location, { redirect: "manual" });
    const callbackUrl = new URL(idpRedirect.headers.get("location"));
    const callback = await call(
      "GET",
      `${callbackUrl.pathname}${callbackUrl.search}`,
      { cookie: flowCookie }
    );
    assert.equal(callback.status, 403);
    assert.equal(callback.payload.error, "forbidden");
    assert.match(callback.payload.message, /stranger@example\.com/);
  } finally {
    idp.updateUser({ email: "alice@example.com", name: "Alice", sub: "user-alice" });
  }
});

test("OIDC callback rejects requests without the flow cookie", async () => {
  // Fabricate a plausible-looking callback URL with no cookie.
  const callback = await call("GET", "/v1/auth/oidc/callback?code=abc&state=xyz");
  assert.equal(callback.status, 400);
  assert.match(callback.payload.message, /flow state/);
});

test("/v1/auth/oidc/login returns 404 for disabled or unknown providers", async () => {
  const disabled = await call("GET", "/v1/auth/oidc/login?provider_id=00000000-0000-4000-8000-eeee99999999");
  assert.equal(disabled.status, 404);

  const provider = seedProvider({
    name: "okta",
    issuer: idp.issuer,
    client_id: idp.clientId,
    client_secret: idp.clientSecret,
    redirect_uri: `${baseUrl}/v1/auth/oidc/callback`,
    enabled: false
  });
  const result = await call("GET", `/v1/auth/oidc/login?provider_id=${provider.id}`);
  assert.equal(result.status, 404);
});
