// AUTH-009: end-to-end coverage for the hardening work — baseline security
// headers on every response, complete session-cookie attributes, and the
// brute-force lockout that returns 429 with a Retry-After header.
//
// We point the lockout service at a small window via env vars so the assertion
// path doesn't have to wait minutes.

const { test, before, after, beforeEach } = require("node:test");
const assert = require("node:assert/strict");

process.env.DATABASE_URL = process.env.DATABASE_URL || "postgresql://test:test@localhost:5432/test";
process.env.PORT = "0";
process.env.AUTH_COOKIE_SECURE = "false";
process.env.AUTH_LOCKOUT_WINDOW_MS = "60000";
process.env.AUTH_LOCKOUT_EMAIL_THRESHOLD = "3";
process.env.AUTH_LOCKOUT_IP_THRESHOLD = "10";

const appDb = require("../src/lib/appDb");
const authService = require("../src/services/authService");

let server;
let baseUrl;
let users;
let sessions;
let auditRows;
let originalQuery;
let userCounter;
let sessionCounter;
let auditCounter;

function uuid(prefix, counter) {
  return `00000000-0000-4000-8000-${prefix}${String(counter).padStart(8, "0")}`;
}

function normalize(sql) {
  return String(sql).replace(/\s+/g, " ").trim().toLowerCase();
}

async function call(method, path, { cookie, body } = {}) {
  const headers = { "Content-Type": "application/json" };
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
  return {
    status: response.status,
    payload,
    setCookie: response.headers.get("set-cookie"),
    headers: response.headers
  };
}

function emailFailureCount(email) {
  return auditRows.filter(
    (r) => r.action === "auth.login.failure" && r.actor_email === email.toLowerCase()
  ).length;
}

before(async () => {
  originalQuery = appDb.query;
  users = new Map();
  sessions = new Map();
  auditRows = [];
  userCounter = 0;
  sessionCounter = 0;
  auditCounter = 0;

  // Seed an active user we can log in as.
  userCounter += 1;
  const userId = uuid("aaaa", userCounter);
  users.set(userId, {
    id: userId,
    email: "alice@example.com",
    password_hash: authService.hashPassword("Hunter22ok!"),
    display_name: "Alice",
    is_active: true,
    last_login_at: null,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString()
  });

  appDb.query = async (sql, params = []) => {
    const n = normalize(sql);

    if (n.startsWith("select id, email, password_hash, display_name, is_active, last_login_at, created_at, updated_at from users where lower(email) = $1")) {
      const [emailLower] = params;
      const row = [...users.values()].find((u) => u.email.toLowerCase() === emailLower);
      return row ? { rowCount: 1, rows: [row] } : { rowCount: 0, rows: [] };
    }

    if (n.startsWith("insert into user_sessions")) {
      const [uid, tokenHash, ua, ip, expiresAt] = params;
      sessionCounter += 1;
      const id = uuid("bbbb", sessionCounter);
      sessions.set(id, { id, user_id: uid, token_hash: tokenHash, user_agent: ua, ip_address: ip, expires_at: expiresAt, created_at: new Date().toISOString(), revoked_at: null });
      return { rowCount: 1, rows: [{ id, expires_at: expiresAt }] };
    }

    if (n.startsWith("update users set last_login_at = now() where id = $1")) {
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
        created_at: new Date(Date.now() + auditCounter).toISOString()
      });
      return { rowCount: 1, rows: [] };
    }

    // loginLockoutService — email-window query
    if (n.startsWith("with recent as ( select outcome, created_at from auth_audit_log where action in")) {
      const [emailLower, sinceIso] = params;
      const relevant = auditRows.filter(
        (r) => (r.action === "auth.login.failure" || r.action === "auth.login.success")
          && (r.actor_email || "").toLowerCase() === emailLower
          && r.created_at >= sinceIso
      );
      const lastSuccess = relevant
        .filter((r) => r.outcome === "success")
        .reduce((max, r) => (r.created_at > max ? r.created_at : max), "");
      const failures = relevant
        .filter((r) => r.outcome === "failure" && (lastSuccess === "" || r.created_at > lastSuccess));
      const lastFailureAt = failures.reduce((max, r) => (r.created_at > max ? r.created_at : max), null);
      return { rowCount: 1, rows: [{ failures: failures.length, last_failure_at: lastFailureAt }] };
    }

    // loginLockoutService — IP query
    if (n.startsWith("select count(*)::int as failures, max(created_at) as last_failure_at from auth_audit_log where action = 'auth.login.failure'")) {
      const [ipAddress, sinceIso] = params;
      const matching = auditRows.filter(
        (r) => r.action === "auth.login.failure"
          && r.outcome === "failure"
          && r.ip_address === ipAddress
          && r.created_at >= sinceIso
      );
      const lastFailureAt = matching.reduce((max, r) => (r.created_at > max ? r.created_at : max), null);
      return { rowCount: 1, rows: [{ failures: matching.length, last_failure_at: lastFailureAt }] };
    }

    // Session lookup (after successful login, used by /v1/auth/me) — not
    // strictly needed by this suite but kept for completeness.
    if (n.startsWith("select s.id as session_id, s.expires_at, s.revoked_at, u.id, u.email")) {
      const [tokenHash] = params;
      const session = [...sessions.values()].find((s) => s.token_hash === tokenHash);
      if (!session) return { rowCount: 0, rows: [] };
      const user = users.get(session.user_id);
      if (!user) return { rowCount: 0, rows: [] };
      return {
        rowCount: 1,
        rows: [{
          session_id: session.id,
          expires_at: session.expires_at,
          revoked_at: session.revoked_at,
          id: user.id,
          email: user.email,
          password_hash: user.password_hash,
          display_name: user.display_name,
          is_active: user.is_active,
          last_login_at: user.last_login_at,
          created_at: user.created_at,
          updated_at: user.updated_at
        }]
      };
    }

    // role / permission lookups during successful login authz hydration —
    // empty result is acceptable, the user just has no roles in the
    // response.
    if (n.startsWith("select r.id, r.name, r.description, r.is_system, ur.assigned_at from user_roles ur")) {
      return { rowCount: 0, rows: [] };
    }
    if (n.startsWith("select distinct p.name from user_roles ur")) {
      return { rowCount: 0, rows: [] };
    }

    throw new Error(`Unexpected SQL in security hardening test stub: ${n}`);
  };

  delete require.cache[require.resolve("../src/server")];
  const { startServer } = require("../src/server");
  server = await startServer();
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  await new Promise((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
  appDb.query = originalQuery;
});

beforeEach(() => {
  auditRows.length = 0;
  auditCounter = 0;
});

test("all responses carry baseline security headers", async () => {
  const result = await call("GET", "/health");
  assert.equal(result.status, 200);
  assert.equal(result.headers.get("x-content-type-options"), "nosniff");
  assert.equal(result.headers.get("x-frame-options"), "DENY");
  assert.equal(result.headers.get("referrer-policy"), "no-referrer");
  const permissions = result.headers.get("permissions-policy");
  assert.ok(permissions && permissions.includes("camera=()"));
  // HSTS is gated on secure cookies / production. Tests run with
  // AUTH_COOKIE_SECURE=false, so HSTS must NOT be set here.
  assert.equal(result.headers.get("strict-transport-security"), null);
});

test("successful login sets a session cookie with HttpOnly, SameSite, and Max-Age", async () => {
  const result = await call("POST", "/v1/auth/login", {
    body: { email: "alice@example.com", password: "Hunter22ok!" }
  });
  assert.equal(result.status, 200);
  assert.ok(result.setCookie, "expected Set-Cookie header");
  assert.match(result.setCookie, /HttpOnly/);
  assert.match(result.setCookie, /SameSite=Lax/);
  assert.match(result.setCookie, /Path=\//);
  const maxAge = result.setCookie.match(/Max-Age=(\d+)/);
  assert.ok(maxAge, "expected Max-Age on the session cookie");
  assert.ok(Number(maxAge[1]) > 0, "Max-Age should be positive");
  // Secure must NOT be set in the test environment (AUTH_COOKIE_SECURE=false).
  assert.doesNotMatch(result.setCookie, /Secure/);
});

test("repeated failed logins return 429 with Retry-After and emit an audit row", async () => {
  const body = { email: "alice@example.com", password: "wrong-Pass-1!" };

  for (let i = 0; i < 3; i += 1) {
    const r = await call("POST", "/v1/auth/login", { body });
    assert.equal(r.status, 401, `attempt ${i + 1} should be 401`);
  }
  // Wait for the audit writes (they are .catch'd and fire asynchronously).
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(emailFailureCount("alice@example.com"), 3);

  const locked = await call("POST", "/v1/auth/login", { body });
  assert.equal(locked.status, 429);
  assert.equal(locked.payload.error, "too_many_requests");
  assert.equal(locked.payload.reason, "too_many_failed_logins");
  assert.ok(locked.payload.retry_after_seconds >= 1);
  assert.equal(
    locked.headers.get("retry-after"),
    String(locked.payload.retry_after_seconds)
  );
  await new Promise((resolve) => setImmediate(resolve));
  const lockoutRow = auditRows.find((r) => r.action === "auth.login.locked_out");
  assert.ok(lockoutRow, "lockout attempts must be recorded");
  assert.equal(lockoutRow.outcome, "failure");
  assert.equal(lockoutRow.details.reason, "too_many_failed_logins");
});

test("a successful login mid-window resets the email-side strike counter", async () => {
  // Three failures bring us to the threshold (which is `>=`, not `>`),
  // so the next login attempt would normally be locked. A successful login
  // between them must reset the count and let the user proceed.
  const wrong = { email: "alice@example.com", password: "wrong-Pass-1!" };
  const right = { email: "alice@example.com", password: "Hunter22ok!" };

  for (let i = 0; i < 2; i += 1) {
    const r = await call("POST", "/v1/auth/login", { body: wrong });
    assert.equal(r.status, 401);
  }
  await new Promise((resolve) => setImmediate(resolve));

  const success = await call("POST", "/v1/auth/login", { body: right });
  assert.equal(success.status, 200);
  await new Promise((resolve) => setImmediate(resolve));

  // After the success, two more failures should be allowed (not locked).
  for (let i = 0; i < 2; i += 1) {
    const r = await call("POST", "/v1/auth/login", { body: wrong });
    assert.equal(r.status, 401, `post-success attempt ${i + 1} should still be 401, not 429`);
  }
});
