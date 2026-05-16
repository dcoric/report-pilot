// AUTH-006: end-to-end coverage for the /v1/users/me/config endpoint pair.

const { test, before, after, beforeEach } = require("node:test");
const assert = require("node:assert/strict");

process.env.DATABASE_URL = process.env.DATABASE_URL || "postgresql://test:test@localhost:5432/test";
process.env.PORT = "0";
process.env.AUTH_COOKIE_SECURE = "false";

const appDb = require("../src/lib/appDb");
const { createAuthTestStub } = require("./helpers/authTestStub");

let server;
let baseUrl;
let authStub;
let originalQuery;
let configs;       // user_id -> stored config object
let dataSources;   // id -> row

let analystCookie;
let viewerCookie;

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
  return { status: response.status, payload };
}

before(async () => {
  authStub = createAuthTestStub();
  originalQuery = appDb.query;
  configs = new Map();
  dataSources = new Map();

  const analyst = authStub.seedUser({ email: "alice@example.com", roles: ["analyst"], password: "Hunter22ok!" });
  analystCookie = authStub.cookieFor(authStub.seedSession(analyst.id).token);
  const viewer = authStub.seedUser({ email: "vince@example.com", roles: ["viewer"], password: "Hunter22ok!" });
  viewerCookie = authStub.cookieFor(authStub.seedSession(viewer.id).token);

  // Pre-seed a data source so the validation FK check has something to find.
  dataSources.set("00000000-0000-4000-8000-d5d5d5d5d5d5", { id: "00000000-0000-4000-8000-d5d5d5d5d5d5" });

  appDb.query = async (sql, params = []) => {
    const auth = authStub.handleSql(sql, params);
    if (auth) return auth;

    const n = normalize(sql);

    if (n.startsWith("select config, updated_at from user_configs where user_id = $1")) {
      const [userId] = params;
      const row = configs.get(userId);
      return row
        ? { rowCount: 1, rows: [{ config: row, updated_at: new Date().toISOString() }] }
        : { rowCount: 0, rows: [] };
    }

    if (n.startsWith("insert into user_configs (user_id, config, updated_at)")) {
      const [userId, configJson] = params;
      configs.set(userId, JSON.parse(configJson));
      return { rowCount: 1, rows: [] };
    }

    if (n.startsWith("select id from data_sources where id = $1")) {
      const [id] = params;
      return dataSources.has(id)
        ? { rowCount: 1, rows: [{ id }] }
        : { rowCount: 0, rows: [] };
    }

    throw new Error(`Unexpected SQL in user-config test stub: ${n}`);
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
  configs.clear();
});

test("GET requires authentication", async () => {
  const result = await call("GET", "/v1/users/me/config");
  assert.equal(result.status, 401);
});

test("GET returns baseline defaults when nothing is saved", async () => {
  const result = await call("GET", "/v1/users/me/config", { cookie: analystCookie });
  assert.equal(result.status, 200);
  assert.equal(result.payload.config.theme, "system");
  assert.equal(result.payload.config.max_rows, 1000);
  assert.equal(result.payload.config.default_data_source_id, null);
});

test("PUT saves a config; subsequent GET returns it", async () => {
  const put = await call("PUT", "/v1/users/me/config", {
    cookie: analystCookie,
    body: {
      default_data_source_id: "00000000-0000-4000-8000-d5d5d5d5d5d5",
      max_rows: 500,
      timeout_seconds: 60,
      theme: "dark",
      table_preferences: { rowsPerPage: 25 }
    }
  });
  assert.equal(put.status, 200, JSON.stringify(put.payload));
  assert.equal(put.payload.config.theme, "dark");
  assert.equal(put.payload.config.max_rows, 500);

  const get = await call("GET", "/v1/users/me/config", { cookie: analystCookie });
  assert.equal(get.status, 200);
  assert.equal(get.payload.config.default_data_source_id, "00000000-0000-4000-8000-d5d5d5d5d5d5");
  assert.equal(get.payload.config.theme, "dark");
});

test("PUT rejects an unknown data source with a stable code", async () => {
  const result = await call("PUT", "/v1/users/me/config", {
    cookie: analystCookie,
    body: { default_data_source_id: "00000000-0000-4000-8000-deadbeef0001" }
  });
  assert.equal(result.status, 400);
  assert.equal(result.payload.code, "unknown_default_data_source");
});

test("PUT rejects an invalid theme with a stable code", async () => {
  const result = await call("PUT", "/v1/users/me/config", {
    cookie: analystCookie,
    body: { theme: "neon" }
  });
  assert.equal(result.status, 400);
  assert.equal(result.payload.code, "invalid_theme");
});

test("PUT rejects unknown fields", async () => {
  const result = await call("PUT", "/v1/users/me/config", {
    cookie: analystCookie,
    body: { rogue_field: 42 }
  });
  assert.equal(result.status, 400);
  assert.equal(result.payload.code, "unknown_field");
});

test("viewer role can also read and write their own config", async () => {
  // The two new permissions are granted to admin / analyst / viewer alike.
  const put = await call("PUT", "/v1/users/me/config", {
    cookie: viewerCookie,
    body: { theme: "light" }
  });
  assert.equal(put.status, 200);
  const get = await call("GET", "/v1/users/me/config", { cookie: viewerCookie });
  assert.equal(get.payload.config.theme, "light");
});
