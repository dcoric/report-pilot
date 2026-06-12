// AUTH-008: end-to-end coverage for the audit trail.
//
// What this exercises:
//   - Failed-login attempts write an `auth.login.failure` row whose actor is
//     the supplied email (no user_id) and whose outcome is "failure".
//   - Successful logins write an `auth.login.success` row.
//   - Logout writes an `auth.logout` row.
//   - GET /v1/admin/audit-events is admin-only, paginates, and filters by
//     action / outcome.
//
// The DB layer is stubbed with an in-memory `auth_audit_log` that matches the
// auditService SQL contract (column order, JSONB cast, sort by created_at DESC).

import "./helpers/setupEnv";
import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";

process.env.DATABASE_URL = process.env.DATABASE_URL || "postgresql://test:test@localhost:5432/test";
process.env.PORT = "0";
process.env.AUTH_COOKIE_SECURE = "false";

import appDb = require("../src/lib/appDb");
import authService = require("../src/services/authService");
import { createAuthTestStub } from "./helpers/authTestStub";

let server: import("http").Server;
let baseUrl: string;
let authStub: import("./helpers/authTestStub").AuthTestStub;
let originalQuery: typeof appDb.query;
let auditRows;
let auditCounter;
let users; // additional users not seeded via the stub (kept by id)

function uuid(prefix: string, counter: number) {
  return `00000000-0000-4000-8000-${prefix}${String(counter).padStart(8, "0")}`;
}

function normalize(sql: string) {
  return String(sql).replace(/\s+/g, " ").trim().toLowerCase();
}

async function call(method: string, path: string, { cookie, body }: { cookie?: string; body?: unknown } = {}) {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (cookie) headers.Cookie = cookie;
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined
  });
  let payload = null;
  if ((response.headers.get("content-type") || "").includes("application/json")) {
    try { payload = await response.json(); } catch { payload = null; }
  }
  return { status: response.status, payload, setCookie: response.headers.get("set-cookie") };
}

function parseSessionCookieValue(setCookieHeader) {
  if (!setCookieHeader) return null;
  const match = setCookieHeader.match(/rp_session=([^;]*)/);
  return match ? decodeURIComponent(match[1]) : null;
}

function applyFilters(rows, params) {
  let out = [...rows];
  const conditions = []; // mirror order auditService.listEvents builds
  // We replay the same predicate set here. params start at $1 in the SQL but
  // we already know the JS-side order; just check by name supplied at call.
  if (params._action) out = out.filter((r) => r.action === params._action);
  if (params._actorUserId) out = out.filter((r) => r.actor_user_id === params._actorUserId);
  if (params._targetUserId) out = out.filter((r) => r.target_user_id === params._targetUserId);
  if (params._outcome) out = out.filter((r) => r.outcome === params._outcome);
  if (params._since) out = out.filter((r) => r.created_at >= params._since);
  if (params._until) out = out.filter((r) => r.created_at < params._until);
  // unused; conditions stay separate so we can audit them later if needed
  void conditions;
  return out;
}

before(async () => {
  authStub = createAuthTestStub();
  originalQuery = appDb.query;
  auditRows = [];
  auditCounter = 0;
  users = new Map();

  // Active admin user used to read the audit log.
  const admin = authStub.seedUser({ email: "admin@example.com", roles: ["admin"], password: "hunter22ok" });
  users.set(admin.id, admin);
  // Active non-admin user (for the password-login happy path).
  const analyst = authStub.seedUser({ email: "alice@example.com", roles: ["analyst"], password: "hunter22ok" });
  users.set(analyst.id, analyst);

  appDb.query = (async (sql, params = []) => {
    // First let the shared auth stub handle session/role lookups.
    const auth = authStub.handleSql(sql, params);
    if (auth) return auth;

    const n = normalize(sql);

    // findUserByEmail
    if (n.startsWith("select id, email, password_hash, display_name, is_active, last_login_at, created_at, updated_at from users where lower(email) = $1")) {
      const [emailLower] = params;
      const row = [...users.values()].find((u) => u.email.toLowerCase() === emailLower);
      return row ? { rowCount: 1, rows: [row] } : { rowCount: 0, rows: [] };
    }

    // touchLastLogin
    if (n.startsWith("update users set last_login_at = now() where id = $1")) {
      return { rowCount: 1, rows: [] };
    }

    // revokeSessionByToken
    if (n.startsWith("update user_sessions set revoked_at = now() where token_hash = $1 and revoked_at is null")) {
      return { rowCount: 1, rows: [] };
    }

    // auditService.writeEvent insert
    if (n.startsWith("insert into auth_audit_log")) {
      const [actorUserId, actorEmail, targetUserId, action, outcome, detailsJson, ipAddress, userAgent] = params;
      auditCounter += 1;
      auditRows.push({
        id: uuid("dddd", auditCounter),
        actor_user_id: actorUserId,
        actor_email: actorEmail,
        target_user_id: targetUserId,
        action,
        outcome,
        details: JSON.parse(detailsJson),
        ip_address: ipAddress,
        user_agent: userAgent,
        // ensure stable ordering: insertion order also reflects time order
        created_at: new Date(Date.now() + auditCounter).toISOString()
      });
      return { rowCount: 1, rows: [] };
    }

    // auditService.listEvents — count
    if (n.startsWith("select count(*)::bigint as total from auth_audit_log a")) {
      const filters = parseListFilters(sql, params);
      const filtered = applyFilters(auditRows, filters);
      return { rowCount: 1, rows: [{ total: BigInt(filtered.length).toString() }] };
    }

    // auditService.listEvents — page
    if (n.startsWith("select a.id, a.actor_user_id, a.actor_email, a.target_user_id, a.action, a.outcome, a.details, a.ip_address, a.user_agent, a.created_at, au.email as actor_user_email, au.display_name as actor_user_display_name, tu.email as target_user_email, tu.display_name as target_user_display_name from auth_audit_log a")) {
      const filters = parseListFilters(sql, params);
      const filtered = applyFilters(auditRows, filters)
        .sort((a, b) => (b.created_at + b.id).localeCompare(a.created_at + a.id));
      const limit = filters._limit;
      const offset = filters._offset;
      const page = filtered.slice(offset, offset + limit).map((row) => {
        const actor = row.actor_user_id ? users.get(row.actor_user_id) : null;
        const target = row.target_user_id ? users.get(row.target_user_id) : null;
        return {
          ...row,
          actor_user_email: actor ? actor.email : null,
          actor_user_display_name: actor ? actor.display_name : null,
          target_user_email: target ? target.email : null,
          target_user_display_name: target ? target.display_name : null
        };
      });
      return { rowCount: page.length, rows: page };
    }

    throw new Error(`Unexpected SQL in audit-events test stub: ${n}`);
  }) as unknown as typeof appDb.query;

  delete require.cache[require.resolve("../src/server")];
  const { startServer } = require("../src/server");
  server = await startServer();
  baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});

after(async () => {
  await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
  appDb.query = originalQuery;
});

beforeEach(() => {
  auditRows.length = 0;
  auditCounter = 0;
});

// Extracts the filter values from the SQL parameters by inspecting which named
// predicates the auditService built. The service appends parameters in a known
// order, ending with $LIMIT and $OFFSET. We don't try to parse the SQL —
// instead, the helper mirrors the construction in auditService.listEvents.
function parseListFilters(sql, params) {
  const filters = {
    _action: null,
    _actorUserId: null,
    _targetUserId: null,
    _outcome: null,
    _since: null,
    _until: null,
    _limit: 50,
    _offset: 0
  };
  // Match the predicates that exist in the SQL to figure out which params slot
  // into which filter (count vs list queries share the WHERE clause).
  const order = [];
  if (/a\.action = \$/.test(sql)) order.push("_action");
  if (/a\.actor_user_id = \$/.test(sql)) order.push("_actorUserId");
  if (/a\.target_user_id = \$/.test(sql)) order.push("_targetUserId");
  if (/a\.outcome = \$/.test(sql)) order.push("_outcome");
  if (/a\.created_at >= \$/.test(sql)) order.push("_since");
  if (/a\.created_at < \$/.test(sql)) order.push("_until");

  for (let i = 0; i < order.length; i += 1) {
    filters[order[i]] = params[i];
  }
  const isListQuery = /limit \$/i.test(sql);
  if (isListQuery) {
    filters._limit = Number(params[params.length - 2]);
    filters._offset = Number(params[params.length - 1]);
  }
  return filters;
}

test("failed password login records auth.login.failure with the supplied email", async () => {
  const result = await call("POST", "/v1/auth/login", {
    body: { email: "nobody@example.com", password: "supersecret" }
  });
  assert.equal(result.status, 401);

  // give the .catch'd audit promise a tick to settle
  await new Promise((r) => setImmediate(r));

  const failures = auditRows.filter((r) => r.action === "auth.login.failure");
  assert.equal(failures.length, 1);
  assert.equal(failures[0].outcome, "failure");
  assert.equal(failures[0].actor_user_id, null);
  assert.equal(failures[0].actor_email, "nobody@example.com");
  assert.deepEqual(failures[0].details, { reason: "invalid_credentials" });
});

test("successful login and logout each record an audit event tied to the user", async () => {
  const login = await call("POST", "/v1/auth/login", {
    body: { email: "alice@example.com", password: "hunter22ok" }
  });
  assert.equal(login.status, 200);
  const token = parseSessionCookieValue(login.setCookie);
  await new Promise((r) => setImmediate(r));

  const success = auditRows.find((r) => r.action === "auth.login.success");
  assert.ok(success, "expected auth.login.success");
  assert.equal(success.outcome, "success");
  assert.equal(success.actor_email, "alice@example.com");
  assert.equal(success.actor_user_id, success.target_user_id);
  assert.equal(success.details.method, "password");

  const cookie = `rp_session=${encodeURIComponent(token)}`;
  const logout = await call("POST", "/v1/auth/logout", { cookie });
  assert.equal(logout.status, 200);
  await new Promise((r) => setImmediate(r));

  const logoutRow = auditRows.find((r) => r.action === "auth.logout");
  assert.ok(logoutRow, "expected auth.logout");
  assert.equal(logoutRow.outcome, "success");
  assert.equal(logoutRow.actor_email, "alice@example.com");
});

test("GET /v1/admin/audit-events lists events newest-first with pagination", async () => {
  const adminUser = [...users.values()].find((u) => u.email === "admin@example.com");
  const adminCookie = authStub.cookieFor(authStub.seedSession(adminUser.id).token);

  // Trigger a few events.
  await call("POST", "/v1/auth/login", { body: { email: "nobody@example.com", password: "x".repeat(10) } });
  await call("POST", "/v1/auth/login", { body: { email: "alice@example.com", password: "hunter22ok" } });
  await new Promise((r) => setImmediate(r));

  const list = await call("GET", "/v1/admin/audit-events", { cookie: adminCookie });
  assert.equal(list.status, 200);
  assert.equal(list.payload.limit, 50);
  assert.equal(list.payload.offset, 0);
  assert.ok(list.payload.total >= 2);
  // Reverse chronological: failure (recorded first) appears AFTER success.
  const actions = list.payload.items.map((it) => it.action);
  assert.ok(actions.indexOf("auth.login.success") < actions.indexOf("auth.login.failure"));

  // Pagination
  const paged = await call("GET", "/v1/admin/audit-events?limit=1", { cookie: adminCookie });
  assert.equal(paged.payload.items.length, 1);
  assert.equal(paged.payload.limit, 1);
});

test("GET /v1/admin/audit-events filters by action and outcome", async () => {
  const adminUser = [...users.values()].find((u) => u.email === "admin@example.com");
  const adminCookie = authStub.cookieFor(authStub.seedSession(adminUser.id).token);

  await call("POST", "/v1/auth/login", { body: { email: "nobody@example.com", password: "x".repeat(10) } });
  await call("POST", "/v1/auth/login", { body: { email: "alice@example.com", password: "hunter22ok" } });
  await new Promise((r) => setImmediate(r));

  const byAction = await call("GET", "/v1/admin/audit-events?action=auth.login.failure", { cookie: adminCookie });
  assert.equal(byAction.status, 200);
  assert.ok(byAction.payload.items.every((it) => it.action === "auth.login.failure"));
  assert.ok(byAction.payload.items.length >= 1);

  const byOutcome = await call("GET", "/v1/admin/audit-events?outcome=failure", { cookie: adminCookie });
  assert.ok(byOutcome.payload.items.every((it) => it.outcome === "failure"));
});

test("GET /v1/admin/audit-events is admin-only", async () => {
  const analystUser = [...users.values()].find((u) => u.email === "alice@example.com");
  const analystCookie = authStub.cookieFor(authStub.seedSession(analystUser.id).token);

  const forbidden = await call("GET", "/v1/admin/audit-events", { cookie: analystCookie });
  assert.equal(forbidden.status, 403);

  const unauthenticated = await call("GET", "/v1/admin/audit-events");
  assert.equal(unauthenticated.status, 401);
});

test("audit list rejects malformed uuid filters", async () => {
  const adminUser = [...users.values()].find((u) => u.email === "admin@example.com");
  const adminCookie = authStub.cookieFor(authStub.seedSession(adminUser.id).token);

  const badActor = await call("GET", "/v1/admin/audit-events?actor_user_id=not-a-uuid", { cookie: adminCookie });
  assert.equal(badActor.status, 400);

  const badTarget = await call("GET", "/v1/admin/audit-events?target_user_id=not-a-uuid", { cookie: adminCookie });
  assert.equal(badTarget.status, 400);
});

// Silence the variable-unused warning by exporting the helper modules used at
// the top — keeps lint happy without changing runtime behavior.
void authService;
