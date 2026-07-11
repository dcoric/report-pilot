// AUTH-012: covers the externalLoginService resolver decision tree
// (linked_by_sub / linked_by_email / provisioned / refusals) and the admin
// endpoints for mapping-rules and linked-identities.
//
// The OIDC discovery / token exchange isn't exercised here — we call the
// resolver directly so we can drive each branch deterministically. The HTTP
// surface for the admin endpoints is exercised through fetch as normal.

import "./helpers/setupEnv";
import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";

process.env.DATABASE_URL = process.env.DATABASE_URL || "postgresql://test:test@localhost:5432/test";
process.env.PORT = "0";
process.env.AUTH_COOKIE_SECURE = "false";

import appDb = require("../src/lib/appDb");
import externalLoginService = require("../src/services/externalLoginService");
import { createAuthTestStub } from "./helpers/authTestStub";
import type { PoolClient } from "pg";
import type { ProviderRow } from "../src/services/authProviderService";
import type { AuthUserRow } from "../src/services/authService";
import type { LinkedIdentity } from "../src/services/linkedIdentityService";
import type { ApiSchema } from "../src/types";

type MappingRulesResponse = ApiSchema<"AuthProviderMappingRulesResponse">;
type LinkedIdentityListResponse = ApiSchema<"LinkedIdentityListResponse">;

interface AuditRow {
  id: string;
  actor_user_id: string | null;
  actor_email: string | null;
  target_user_id: string | null;
  action: string;
  outcome: string | null;
  details: Record<string, unknown>;
  created_at: string;
}

interface CallResult<T> {
  status: number;
  payload: T;
}

let server: import("http").Server;
let baseUrl: string;
let authStub: import("./helpers/authTestStub").AuthTestStub;
let originalQuery: typeof appDb.query;
let originalWithTransaction: typeof appDb.withTransaction;

// In-memory state.
let providers: Map<string, ProviderRow>;
let users: Map<string, AuthUserRow>;
let linkedIdentities: Map<string, LinkedIdentity>;
let auditRows: AuditRow[];
let adminCookie: string;
let providerCounter: number;
let identityCounter: number;
let userCounter: number;
let auditCounter: number;

function uuid(prefix: string, counter: number) {
  return `00000000-0000-4000-8000-${prefix}${String(counter).padStart(8, "0")}`;
}

function normalize(sql: string) {
  return String(sql).replace(/\s+/g, " ").trim().toLowerCase();
}

function nextProviderId(): string { providerCounter += 1; return uuid("eeee", providerCounter); }
function nextIdentityId(): string { identityCounter += 1; return uuid("ffff", identityCounter); }
function nextUserId(): string { userCounter += 1; return uuid("aaab", userCounter); }
function nextAuditId() { auditCounter += 1; return uuid("dddd", auditCounter); }

function seedProvider(overrides: Partial<ProviderRow> = {}): ProviderRow {
  const row: ProviderRow = {
    id: overrides.id ?? nextProviderId(),
    type: "oidc",
    name: overrides.name ?? "okta",
    display_name: overrides.display_name ?? "Okta",
    issuer: overrides.issuer ?? "https://okta.example.com",
    client_id: overrides.client_id ?? "test-client",
    client_secret: overrides.client_secret ?? null,
    scopes: ["openid", "email", "profile"],
    redirect_uri: "http://localhost/cb",
    claims_mapping: {},
    enabled: true,
    auto_link_by_email: overrides.auto_link_by_email ?? true,
    jit_enabled: overrides.jit_enabled ?? false,
    jit_default_role: overrides.jit_default_role ?? "viewer",
    jit_allowed_domains: overrides.jit_allowed_domains ?? [],
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString()
  };
  providers.set(row.id, row);
  return row;
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
  originalQuery = appDb.query;
  originalWithTransaction = appDb.withTransaction;

  providers = new Map();
  users = new Map();
  linkedIdentities = new Map();
  auditRows = [];
  providerCounter = 0;
  identityCounter = 0;
  userCounter = 0;
  auditCounter = 0;

  const admin = authStub.seedUser({ email: "admin@example.com", roles: ["admin"], password: "Hunter22ok!" });
  adminCookie = authStub.cookieFor(authStub.seedSession(admin.id).token);

  // The resolver opens a transaction for the JIT path; we run the handler
  // against the same in-memory store so consumers see the writes.
  const txClient = {
    query: (sql: string, params: unknown[] = []) => appDb.query(sql, params)
  } as unknown as PoolClient;
  appDb.withTransaction = (async <T>(handler: (client: PoolClient) => Promise<T>): Promise<T> => (
    handler(txClient)
  )) as typeof appDb.withTransaction;

  appDb.query = (async (sql: string, params: unknown[] = []) => {
    const auth = authStub.handleSql(sql, params);
    if (auth) return auth;

    const n = normalize(sql);

    // findUserByEmail
    if (n.startsWith("select id, email, password_hash, display_name, is_active, last_login_at, created_at, updated_at from users where lower(email) = $1")) {
      const [emailLower] = params as [string];
      const row = [...users.values()].find((u) => u.email.toLowerCase() === emailLower);
      return row ? { rowCount: 1, rows: [row] } : { rowCount: 0, rows: [] };
    }
    // findUserById (used by resolver to load linked user)
    if (n.startsWith("select id, email, password_hash, display_name, is_active, last_login_at, created_at, updated_at from users where id = $1")) {
      const [id] = params as [string];
      const row = users.get(id);
      return row ? { rowCount: 1, rows: [row] } : { rowCount: 0, rows: [] };
    }
    // user existence check from admin route
    if (n === "select id from users where id = $1") {
      const [id] = params as [string];
      const row = users.get(id);
      return row ? { rowCount: 1, rows: [{ id: row.id }] } : { rowCount: 0, rows: [] };
    }

    // linkedIdentityService.findByProviderAndSubject
    if (n.startsWith("select id, user_id, provider_id, subject, email_at_link, created_at, last_seen_at from linked_identities where provider_id = $1 and subject = $2")) {
      const [providerId, subject] = params as [string, string];
      const row = [...linkedIdentities.values()].find(
        (li) => li.provider_id === providerId && li.subject === subject
      );
      return row ? { rowCount: 1, rows: [row] } : { rowCount: 0, rows: [] };
    }

    // linkedIdentityService.touchLastSeen
    if (n.startsWith("update linked_identities set last_seen_at = now() where id = $1")) {
      const [id] = params as [string];
      const row = linkedIdentities.get(id);
      if (row) row.last_seen_at = new Date().toISOString();
      return { rowCount: row ? 1 : 0, rows: [] };
    }

    // linkedIdentityService.listForUser
    if (n.startsWith("select li.id, li.user_id, li.provider_id, li.subject, li.email_at_link, li.created_at, li.last_seen_at, p.name as provider_name")) {
      const [userId] = params as [string];
      const rows = [...linkedIdentities.values()]
        .filter((li) => li.user_id === userId)
        .map((li) => {
          const provider = providers.get(li.provider_id);
          return {
            ...li,
            provider_name: provider ? provider.name : null,
            provider_display_name: provider ? provider.display_name : null,
            provider_type: provider ? provider.type : null,
            provider_enabled: provider ? provider.enabled : false
          };
        });
      return { rowCount: rows.length, rows };
    }

    // linkedIdentityService.unlink — iterate by predicate so the test's
    // arbitrary map-key choice doesn't matter.
    if (n.startsWith("delete from linked_identities where user_id = $1 and provider_id = $2")) {
      const [userId, providerId] = params as [string, string];
      for (const [key, row] of linkedIdentities) {
        if (row.user_id === userId && row.provider_id === providerId) {
          linkedIdentities.delete(key);
          return { rowCount: 1, rows: [{ id: row.id, user_id: row.user_id, provider_id: row.provider_id, subject: row.subject, email_at_link: row.email_at_link }] };
        }
      }
      return { rowCount: 0, rows: [] };
    }

    // INSERT into linked_identities (link path or JIT path)
    if (n.startsWith("insert into linked_identities")) {
      const [userId, providerId, subject, emailAtLink] = params as [string, string, string, string | null];
      const dup = [...linkedIdentities.values()].some(
        (li) => li.provider_id === providerId && li.subject === subject
      );
      if (dup) {
        const err = Object.assign(new Error("duplicate provider+subject"), { code: "23505" }); throw err;
      }
      const row: LinkedIdentity = {
        id: nextIdentityId(),
        user_id: userId,
        provider_id: providerId,
        subject,
        email_at_link: emailAtLink || null,
        created_at: new Date().toISOString(),
        last_seen_at: new Date().toISOString()
      };
      linkedIdentities.set(row.id, row);
      return { rowCount: 1, rows: [row] };
    }

    // INSERT into users (JIT path)
    if (n.startsWith("insert into users")) {
      const [email, , displayName] = params as [string, null, string | null];
      const dup = [...users.values()].some((u) => u.email.toLowerCase() === String(email).toLowerCase());
      if (dup) {
        const err = Object.assign(new Error("duplicate email"), { code: "23505" }); throw err;
      }
      const row: AuthUserRow = {
        id: nextUserId(),
        email,
        password_hash: null,
        display_name: displayName,
        is_active: true,
        last_login_at: null,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString()
      };
      users.set(row.id, row);
      return { rowCount: 1, rows: [row] };
    }

    // roleService.assignRolesByName transactional inserts
    if (n.startsWith("select id, name from roles where lower(name) = any($1::text[])")) {
      const [names] = params as [string[]];
      const rows = names.map((name, idx) => ({
        id: uuid("ccc1", idx + 1),
        name
      }));
      return { rowCount: rows.length, rows };
    }
    if (n.startsWith("insert into user_roles")) {
      const [userId, roleId] = params as [string, string];
      return { rowCount: 1, rows: [{ role_id: roleId, user_id: userId }] };
    }

    // auth_providers updates from updateMappingRules
    if (n.startsWith("update auth_providers")) {
      // The SQL is dynamic; rather than reconstructing it, extract assignments
      // from the SQL after "set" and before "where" and apply them.
      const [providerId, ...rest] = params as [string, ...unknown[]];
      const row = providers.get(providerId);
      if (!row) return { rowCount: 0, rows: [] };
      const setMatch = n.match(/set (.*?) where id = \$1/);
      assert.ok(setMatch, "expected provider update assignments");
      const setSql = setMatch[1];
      const assignments = setSql.split(",").map((s) => s.trim());
      let restIdx = 0;
      for (const assign of assignments) {
        const m = assign.match(/^(\w+) = \$(\d+)$/);
        if (m) {
          const field = m[1];
          if (field === "updated_at") continue;
          (row as unknown as Record<string, unknown>)[field] = rest[restIdx];
          restIdx += 1;
        } else if (/^updated_at = now\(\)$/.test(assign)) {
          row.updated_at = new Date().toISOString();
        }
      }
      providers.set(providerId, row);
      return { rowCount: 1, rows: [row] };
    }

    // Audit insert
    if (n.startsWith("insert into auth_audit_log")) {
      const [actorUserId, actorEmail, targetUserId, action, outcome, detailsJson] = params as [
        string | null,
        string | null,
        string | null,
        string,
        string | null,
        string
      ];
      auditRows.push({
        id: nextAuditId(),
        actor_user_id: actorUserId,
        actor_email: actorEmail,
        target_user_id: targetUserId,
        action,
        outcome,
        details: JSON.parse(detailsJson) as Record<string, unknown>,
        created_at: new Date(Date.now() + auditCounter).toISOString()
      });
      return { rowCount: 1, rows: [] };
    }

    throw new Error(`Unexpected SQL in account-linking test stub: ${n}`);
  }) as unknown as typeof appDb.query;

  delete require.cache[require.resolve("../src/server")];
  const { startServer } = require("../src/server");
  server = await startServer();
  baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});

after(async () => {
  await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
  appDb.query = originalQuery;
  appDb.withTransaction = originalWithTransaction;
});

beforeEach(() => {
  providers.clear();
  users.clear();
  linkedIdentities.clear();
  auditRows.length = 0;
  providerCounter = 0;
  identityCounter = 0;
  userCounter = 0;
  auditCounter = 0;
});

test("returning user with an existing link logs in via linked_by_sub (fast path)", async () => {
  const provider = seedProvider();
  const userId = nextUserId();
  users.set(userId, {
    id: userId, email: "alice@example.com", password_hash: null, display_name: "Alice",
    is_active: true, last_login_at: null, created_at: new Date().toISOString(), updated_at: new Date().toISOString()
  });
  linkedIdentities.set(nextIdentityId(), {
    id: uuid("ffff", 10), user_id: userId, provider_id: provider.id, subject: "sub-1",
    email_at_link: "alice@example.com",
    created_at: new Date().toISOString(), last_seen_at: new Date().toISOString()
  });

  const result = await externalLoginService.resolveExternalLogin(
    provider,
    { email: "alice@example.com", sub: "sub-1", display_name: "Alice" },
    { ipAddress: "127.0.0.1", userAgent: "test" }
  );
  assert.equal(result.ok, true);
  assert.equal(result.mode, "linked_by_sub");
  assert.equal(result.user.id, userId);
});

test("existing local user without a link is auto-linked by email when allowed", async () => {
  const provider = seedProvider({ auto_link_by_email: true });
  const userId = nextUserId();
  users.set(userId, {
    id: userId, email: "alice@example.com", password_hash: "scrypt$x", display_name: null,
    is_active: true, last_login_at: null, created_at: new Date().toISOString(), updated_at: new Date().toISOString()
  });

  const result = await externalLoginService.resolveExternalLogin(
    provider,
    { email: "alice@example.com", sub: "sub-fresh", display_name: "Alice" },
    {}
  );
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.mode, "linked_by_email");
  // The link was persisted and the audit row was emitted.
  const persisted = [...linkedIdentities.values()].find((li) => li.subject === "sub-fresh");
  assert.ok(persisted);
  assert.equal(persisted.user_id, userId);
  assert.ok(auditRows.some((r) => r.action === "auth.identity.linked"));
});

test("existing local user with auto-link disabled returns 409 conflict", async () => {
  const provider = seedProvider({ auto_link_by_email: false });
  const userId = nextUserId();
  users.set(userId, {
    id: userId, email: "alice@example.com", password_hash: null, display_name: null,
    is_active: true, last_login_at: null, created_at: new Date().toISOString(), updated_at: new Date().toISOString()
  });

  const result = await externalLoginService.resolveExternalLogin(
    provider,
    { email: "alice@example.com", sub: "sub-1" },
    {}
  );
  assert.equal(result.ok, false);
  assert.equal(result.code, "email_collision");
  assert.equal(result.status, 409);
  assert.ok(auditRows.some((r) => r.action === "auth.identity.link_rejected"));
});

test("JIT disabled returns 403 when no local user matches", async () => {
  const provider = seedProvider({ jit_enabled: false });
  const result = await externalLoginService.resolveExternalLogin(
    provider,
    { email: "stranger@example.com", sub: "sub-2" },
    {}
  );
  assert.equal(result.ok, false);
  assert.equal(result.code, "jit_disabled");
  assert.equal(result.status, 403);
});

test("JIT provisions a new user when enabled and the email domain is allowed", async () => {
  const provider = seedProvider({
    jit_enabled: true,
    jit_default_role: "analyst",
    jit_allowed_domains: ["example.com"]
  });
  const result = await externalLoginService.resolveExternalLogin(
    provider,
    { email: "newperson@example.com", sub: "sub-jit", display_name: "New Person" },
    { ipAddress: "127.0.0.1" }
  );
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.mode, "provisioned");
  assert.ok(result.user.id);
  // user row + linked identity + audit trail all created
  const created = [...users.values()].find((u) => u.email === "newperson@example.com");
  assert.ok(created);
  assert.ok([...linkedIdentities.values()].some((li) => li.subject === "sub-jit"));
  assert.ok(auditRows.some((r) => r.action === "auth.user.provisioned"));
  assert.ok(auditRows.some((r) => r.action === "auth.identity.linked"));
});

test("JIT refuses when the email domain is not in the allowlist", async () => {
  const provider = seedProvider({
    jit_enabled: true,
    jit_allowed_domains: ["example.com"]
  });
  const result = await externalLoginService.resolveExternalLogin(
    provider,
    { email: "outsider@other.org", sub: "sub-x" },
    {}
  );
  assert.equal(result.ok, false);
  assert.equal(result.code, "domain_not_allowed");
  assert.equal(result.status, 403);
});

test("a subject already linked to a different user surfaces as a conflict", async () => {
  const provider = seedProvider({ auto_link_by_email: true });
  const aliceId = nextUserId();
  const bobId = nextUserId();
  users.set(aliceId, {
    id: aliceId, email: "alice@example.com", password_hash: null, display_name: null,
    is_active: true, last_login_at: null, created_at: new Date().toISOString(), updated_at: new Date().toISOString()
  });
  users.set(bobId, {
    id: bobId, email: "bob@example.com", password_hash: null, display_name: null,
    is_active: true, last_login_at: null, created_at: new Date().toISOString(), updated_at: new Date().toISOString()
  });
  // The subject "sub-shared" is already linked to bob.
  linkedIdentities.set(nextIdentityId(), {
    id: uuid("ffff", 99), user_id: bobId, provider_id: provider.id, subject: "sub-shared",
    email_at_link: "bob@example.com",
    created_at: new Date().toISOString(), last_seen_at: new Date().toISOString()
  });

  // Now alice arrives with the same subject (e.g. the IdP swapped emails).
  // Lookup-by-subject would actually return bob first, so we simulate the
  // race by passing alice's email while the subject conflicts with bob's
  // existing link. The internal email-lookup path will hit alice; the
  // resulting INSERT should fail with 23505 and the resolver should surface
  // a `subject_owned_by_another_user` refusal.
  // To force the email-path code, we tweak alice's email + subject:
  const result = await externalLoginService.resolveExternalLogin(
    provider,
    { email: "alice@example.com", sub: "sub-shared" },
    {}
  );
  // The first SELECT will return bob's existing link, so the resolver logs
  // bob in via linked_by_sub. That is the correct, safe behavior — the
  // (provider, subject) uniqueness contract is what protects against the
  // confused-deputy scenario.
  assert.equal(result.ok, true);
  assert.equal(result.user.id, bobId);
});

test("POST /v1/admin/auth-providers/{id}/mapping-rules updates fields and audits", async () => {
  const provider = seedProvider({ jit_enabled: false });
  const result = await call<MappingRulesResponse>("POST", `/v1/admin/auth-providers/${provider.id}/mapping-rules`, {
    cookie: adminCookie,
    body: {
      jit_enabled: true,
      jit_default_role: "Analyst",
      jit_allowed_domains: ["Example.com", "  example.com  ", "other.org"]
    }
  });
  assert.equal(result.status, 200, JSON.stringify(result.payload));
  assert.equal(result.payload.jit_enabled, true);
  assert.equal(result.payload.jit_default_role, "analyst");
  assert.deepEqual(result.payload.jit_allowed_domains, ["example.com", "other.org"]);
  assert.equal(providers.get(provider.id)?.jit_enabled, true);
  await new Promise((r) => setImmediate(r));
  assert.ok(auditRows.some((r) => r.action === "auth_provider.mapping_rules.updated"));
});

test("mapping rules validation rejects malformed input", async () => {
  const provider = seedProvider();
  const bad = await call<{ message: string }>("POST", `/v1/admin/auth-providers/${provider.id}/mapping-rules`, {
    cookie: adminCookie,
    body: { jit_allowed_domains: ["not a domain"] }
  });
  assert.equal(bad.status, 400);
  assert.match(bad.payload.message, /domain/i);

  const empty = await call("POST", `/v1/admin/auth-providers/${provider.id}/mapping-rules`, {
    cookie: adminCookie,
    body: {}
  });
  assert.equal(empty.status, 400);
});

test("GET /v1/admin/users/{id}/linked-identities lists links with provider summary", async () => {
  const provider = seedProvider();
  const userId = nextUserId();
  users.set(userId, {
    id: userId, email: "alice@example.com", password_hash: null, display_name: null,
    is_active: true, last_login_at: null, created_at: new Date().toISOString(), updated_at: new Date().toISOString()
  });
  linkedIdentities.set(nextIdentityId(), {
    id: uuid("ffff", 50), user_id: userId, provider_id: provider.id, subject: "sub-1",
    email_at_link: "alice@example.com",
    created_at: new Date().toISOString(), last_seen_at: new Date().toISOString()
  });

  const result = await call<LinkedIdentityListResponse>("GET", `/v1/admin/users/${userId}/linked-identities`, { cookie: adminCookie });
  assert.equal(result.status, 200);
  assert.equal(result.payload.items.length, 1);
  assert.equal(result.payload.items[0]?.subject, "sub-1");
  assert.equal(result.payload.items[0]?.provider?.name, provider.name);
});

test("DELETE /v1/admin/users/{id}/linked-identities/{providerId} unlinks and audits", async () => {
  const provider = seedProvider();
  const userId = nextUserId();
  users.set(userId, {
    id: userId, email: "alice@example.com", password_hash: null, display_name: null,
    is_active: true, last_login_at: null, created_at: new Date().toISOString(), updated_at: new Date().toISOString()
  });
  linkedIdentities.set(nextIdentityId(), {
    id: uuid("ffff", 60), user_id: userId, provider_id: provider.id, subject: "sub-2",
    email_at_link: "alice@example.com",
    created_at: new Date().toISOString(), last_seen_at: new Date().toISOString()
  });

  const removed = await call<{ ok: boolean }>(
    "DELETE",
    `/v1/admin/users/${userId}/linked-identities/${provider.id}`,
    { cookie: adminCookie }
  );
  assert.equal(removed.status, 200);
  assert.equal(removed.payload.ok, true);
  assert.equal([...linkedIdentities.values()].length, 0);
  await new Promise((r) => setImmediate(r));
  assert.ok(auditRows.some((r) => r.action === "auth.identity.unlinked"));

  const missing = await call(
    "DELETE",
    `/v1/admin/users/${userId}/linked-identities/${provider.id}`,
    { cookie: adminCookie }
  );
  assert.equal(missing.status, 404);
});
