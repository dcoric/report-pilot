// AUTH-005: end-to-end checks that per-data-source membership is enforced
// across the feature surface, that admins bypass the check, and that the
// admin grant/revoke endpoints work.

const { test, before, after, beforeEach } = require("node:test");
const assert = require("node:assert/strict");

process.env.DATABASE_URL = process.env.DATABASE_URL || "postgresql://test:test@localhost:5432/test";
process.env.PORT = "0";
process.env.AUTH_COOKIE_SECURE = "false";

const appDb = require("../src/lib/appDb");
const { createAuthTestStub } = require("./helpers/authTestStub");

const DS_ALLOWED = "00000000-0000-4000-8000-000000000d51";
const DS_DENIED = "00000000-0000-4000-8000-000000000d52";

let server;
let baseUrl;
let authStub;
let adminCookie;
let analystCookie;
let analystUserId;
let adminUserId;
let originalQuery;
let originalWithTransaction;
let dataSourceAccessRows;
let auditEntries;

async function call(method, path, { cookie, body } = {}) {
  const headers = { "Content-Type": "application/json" };
  if (cookie) headers.Cookie = cookie;
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined
  });
  let payload = null;
  try {
    payload = await response.json();
  } catch {
    payload = null;
  }
  return { status: response.status, payload };
}

function normalize(sql) {
  return String(sql).replace(/\s+/g, " ").trim().toLowerCase();
}

before(async () => {
  originalQuery = appDb.query;
  originalWithTransaction = appDb.withTransaction;
  authStub = createAuthTestStub();
  dataSourceAccessRows = new Map();
  auditEntries = [];

  const admin = authStub.seedUser({ email: "admin@example.com", roles: ["admin"] });
  const analyst = authStub.seedUser({
    email: "analyst@example.com",
    roles: ["analyst"],
    dataSourceAccess: [DS_ALLOWED]
  });
  adminUserId = admin.id;
  analystUserId = analyst.id;
  adminCookie = authStub.cookieFor(authStub.seedSession(admin.id).token);
  analystCookie = authStub.cookieFor(authStub.seedSession(analyst.id).token);

  async function runQuery(sql, params = []) {
    const auth = authStub.handleSql(sql, params);
    if (auth) return auth;

    const n = normalize(sql);

    if (n === "select id from data_sources where id = $1") {
      const [id] = params;
      if (id === DS_ALLOWED || id === DS_DENIED) {
        return { rowCount: 1, rows: [{ id }] };
      }
      return { rowCount: 0, rows: [] };
    }

    if (n === "select id from users where id = $1") {
      const [id] = params;
      if (id === analystUserId || id === adminUserId) {
        return { rowCount: 1, rows: [{ id }] };
      }
      return { rowCount: 0, rows: [] };
    }

    if (n.startsWith("select u.id, u.email, u.display_name, u.is_active, a.granted_at, a.granted_by_user_id")) {
      const [dataSourceId] = params;
      const rows = [];
      for (const [key, row] of dataSourceAccessRows.entries()) {
        const [userId, dsId] = key.split("::");
        if (dsId !== dataSourceId) continue;
        rows.push({
          id: userId,
          email: `${userId}@example.com`,
          display_name: null,
          is_active: true,
          granted_at: row.granted_at,
          granted_by_user_id: row.granted_by_user_id,
          roles: []
        });
      }
      return { rowCount: rows.length, rows };
    }

    if (n.startsWith("insert into user_data_source_access (user_id, data_source_id, granted_by_user_id)")) {
      const [userId, dataSourceId, actorUserId] = params;
      const key = `${userId}::${dataSourceId}`;
      if (dataSourceAccessRows.has(key)) {
        return { rowCount: 0, rows: [] };
      }
      dataSourceAccessRows.set(key, {
        granted_at: new Date().toISOString(),
        granted_by_user_id: actorUserId
      });
      // Also reflect in the auth stub so /v1/* enforcement sees it.
      authStub.grantDataSourceAccess(userId, dataSourceId);
      return { rowCount: 1, rows: [{ user_id: userId }] };
    }

    if (n.startsWith("delete from user_data_source_access where user_id = $1 and data_source_id = $2 returning user_id")) {
      const [userId, dataSourceId] = params;
      const key = `${userId}::${dataSourceId}`;
      const had = dataSourceAccessRows.delete(key);
      if (had) {
        authStub.revokeDataSourceAccess(userId, dataSourceId);
      }
      return { rowCount: had ? 1 : 0, rows: had ? [{ user_id: userId }] : [] };
    }

    if (n.startsWith("insert into auth_audit_log")) {
      // AUTH-008 widened the insert to include actor_email, outcome,
      // ip_address, and user_agent. New positional layout is:
      //   $1 actor_user_id, $2 actor_email, $3 target_user_id, $4 action,
      //   $5 outcome, $6 details, $7 ip_address, $8 user_agent.
      const [actor, actorEmail, target, action, outcome, details, ipAddress, userAgent] = params;
      auditEntries.push({
        actor_user_id: actor,
        actor_email: actorEmail,
        target_user_id: target,
        action,
        outcome,
        details: JSON.parse(details),
        ip_address: ipAddress,
        user_agent: userAgent
      });
      return { rowCount: 1, rows: [] };
    }

    // Permissive fallback for any other domain SQL: empty result so handlers
    // that pass enforcement land on their own 404/400 logic.
    return { rowCount: 0, rows: [] };
  }

  appDb.query = runQuery;
  appDb.withTransaction = async (handler) => handler({ query: runQuery });

  delete require.cache[require.resolve("../src/server")];
  const { startServer } = require("../src/server");
  server = await startServer();
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

beforeEach(() => {
  // Reset the access table for each test but keep the analyst's seed grant
  dataSourceAccessRows.clear();
  auditEntries.length = 0;
  // Restore the seeded grant
  dataSourceAccessRows.set(`${analystUserId}::${DS_ALLOWED}`, {
    granted_at: new Date().toISOString(),
    granted_by_user_id: null
  });
  authStub.revokeDataSourceAccess(analystUserId, DS_DENIED);
  authStub.grantDataSourceAccess(analystUserId, DS_ALLOWED);
});

after(async () => {
  await new Promise((resolve, reject) => {
    server.close((err) => (err ? reject(err) : resolve()));
  });
  appDb.query = originalQuery;
  appDb.withTransaction = originalWithTransaction;
});

test("analyst can act against an allowed data source but is denied 403 on others", async () => {
  // Allowed: GET schema-objects + POST query session + GET rag notes
  const schemaAllowed = await call("GET", `/v1/schema-objects?data_source_id=${DS_ALLOWED}`, { cookie: analystCookie });
  assert.notEqual(schemaAllowed.status, 401);
  assert.notEqual(schemaAllowed.status, 403);

  const queryAllowed = await call("POST", "/v1/query/sessions", {
    cookie: analystCookie,
    body: { data_source_id: DS_ALLOWED, question: "test" }
  });
  assert.notEqual(queryAllowed.status, 403);

  const ragAllowed = await call("GET", `/v1/rag/notes?data_source_id=${DS_ALLOWED}`, { cookie: analystCookie });
  assert.notEqual(ragAllowed.status, 403);

  // Denied: same calls against DS_DENIED
  const schemaDenied = await call("GET", `/v1/schema-objects?data_source_id=${DS_DENIED}`, { cookie: analystCookie });
  assert.equal(schemaDenied.status, 403);

  const queryDenied = await call("POST", "/v1/query/sessions", {
    cookie: analystCookie,
    body: { data_source_id: DS_DENIED, question: "test" }
  });
  assert.equal(queryDenied.status, 403);

  const ragDenied = await call("GET", `/v1/rag/notes?data_source_id=${DS_DENIED}`, { cookie: analystCookie });
  assert.equal(ragDenied.status, 403);

  const ragWriteDenied = await call("POST", "/v1/rag/notes", {
    cookie: analystCookie,
    body: { data_source_id: DS_DENIED, title: "t", content: "c" }
  });
  assert.equal(ragWriteDenied.status, 403);

  const semanticDenied = await call("POST", "/v1/semantic-entities", {
    cookie: analystCookie,
    body: {
      data_source_id: DS_DENIED,
      entity_type: "table",
      target_ref: "public.x",
      business_name: "X"
    }
  });
  assert.equal(semanticDenied.status, 403);

  const reindexDenied = await call("POST", `/v1/rag/reindex?data_source_id=${DS_DENIED}`, { cookie: analystCookie });
  assert.equal(reindexDenied.status, 403);
});

test("admin bypasses the data-source access check", async () => {
  for (const path of [
    `/v1/schema-objects?data_source_id=${DS_DENIED}`,
    `/v1/rag/notes?data_source_id=${DS_DENIED}`
  ]) {
    const result = await call("GET", path, { cookie: adminCookie });
    assert.notEqual(result.status, 403, `admin should not get 403 on ${path}`);
  }

  const adminCreate = await call("POST", "/v1/query/sessions", {
    cookie: adminCookie,
    body: { data_source_id: DS_DENIED, question: "admin" }
  });
  assert.notEqual(adminCreate.status, 403);
});

test("GET /v1/data-sources lists only what the analyst can see (admin sees all)", async () => {
  const adminList = await call("GET", "/v1/data-sources", { cookie: adminCookie });
  assert.equal(adminList.status, 200);

  const analystList = await call("GET", "/v1/data-sources", { cookie: analystCookie });
  assert.equal(analystList.status, 200);
  const ids = (analystList.payload.items || []).map((d) => d.id);
  assert.ok(!ids.includes(DS_DENIED), "analyst should not see DS_DENIED in list");
});

test("admin grant + revoke endpoints update access and audit log", async () => {
  // Initially analyst lacks DS_DENIED
  assert.equal(authStub.handleSql(
    "SELECT 1 FROM user_data_source_access WHERE user_id = $1 AND data_source_id = $2",
    [analystUserId, DS_DENIED]
  ).rowCount, 0);

  const grant = await call("POST", `/v1/admin/data-sources/${DS_DENIED}/access`, {
    cookie: adminCookie,
    body: { user_id: analystUserId }
  });
  assert.equal(grant.status, 201);
  assert.equal(grant.payload.granted, true);

  // Granting again is idempotent (200, granted=false)
  const grantAgain = await call("POST", `/v1/admin/data-sources/${DS_DENIED}/access`, {
    cookie: adminCookie,
    body: { user_id: analystUserId }
  });
  assert.equal(grantAgain.status, 200);
  assert.equal(grantAgain.payload.granted, false);

  // Audit log captured a grant entry
  assert.ok(auditEntries.some((e) => (
    e.action === "data_source.access.granted"
    && e.target_user_id === analystUserId
    && e.details.data_source_id === DS_DENIED
    && e.actor_user_id === adminUserId
  )));

  // Now the analyst can act against DS_DENIED
  const allowedNow = await call("GET", `/v1/rag/notes?data_source_id=${DS_DENIED}`, { cookie: analystCookie });
  assert.notEqual(allowedNow.status, 403);

  // Revoke
  const revoke = await call("DELETE", `/v1/admin/data-sources/${DS_DENIED}/access/${analystUserId}`, { cookie: adminCookie });
  assert.equal(revoke.status, 200);
  assert.equal(revoke.payload.revoked, true);

  // Revoke when no grant exists -> 404
  const revokeAgain = await call("DELETE", `/v1/admin/data-sources/${DS_DENIED}/access/${analystUserId}`, { cookie: adminCookie });
  assert.equal(revokeAgain.status, 404);

  // Audit log captured a revoke entry
  assert.ok(auditEntries.some((e) => (
    e.action === "data_source.access.revoked"
    && e.target_user_id === analystUserId
    && e.details.data_source_id === DS_DENIED
    && e.actor_user_id === adminUserId
  )));

  // Analyst is denied again
  const deniedAgain = await call("GET", `/v1/rag/notes?data_source_id=${DS_DENIED}`, { cookie: analystCookie });
  assert.equal(deniedAgain.status, 403);
});

test("non-admin cannot reach the admin access endpoints", async () => {
  const list = await call("GET", `/v1/admin/data-sources/${DS_ALLOWED}/access`, { cookie: analystCookie });
  assert.equal(list.status, 403);

  const grant = await call("POST", `/v1/admin/data-sources/${DS_ALLOWED}/access`, {
    cookie: analystCookie,
    body: { user_id: adminUserId }
  });
  assert.equal(grant.status, 403);

  const revoke = await call("DELETE", `/v1/admin/data-sources/${DS_ALLOWED}/access/${analystUserId}`, { cookie: analystCookie });
  assert.equal(revoke.status, 403);
});
