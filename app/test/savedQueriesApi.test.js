const { test, before, after, beforeEach } = require("node:test");
const assert = require("node:assert/strict");

process.env.DATABASE_URL = process.env.DATABASE_URL || "postgresql://test:test@localhost:5432/test";
process.env.PORT = "0";

const appDb = require("../src/lib/appDb");

const DATA_SOURCE_ID = "00000000-0000-4000-8000-000000000111";
const OTHER_SOURCE_ID = "00000000-0000-4000-8000-000000000222";
const MISSING_SOURCE_ID = "00000000-0000-4000-8000-000000009999";

let server;
let baseUrl;
let savedQueries;
let savedQueryCounter;
let originalQuery;

function normalizeSql(sql) {
  return String(sql).replace(/\s+/g, " ").trim().toLowerCase();
}

function nextSavedQueryId() {
  savedQueryCounter += 1;
  return `00000000-0000-4000-8000-${String(savedQueryCounter).padStart(12, "0")}`;
}

function duplicateError() {
  const err = new Error("duplicate key value violates unique constraint");
  err.code = "23505";
  return err;
}

function sortSavedQueries(rows) {
  return [...rows].sort((a, b) => {
    const updatedDiff = new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime();
    if (updatedDiff !== 0) {
      return updatedDiff;
    }
    return new Date(b.created_at).getTime() - new Date(a.created_at).getTime();
  });
}

async function api(method, path, body, userId = "test-user") {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      "x-user-id": userId
    },
    body: body ? JSON.stringify(body) : undefined
  });

  let payload = null;
  try {
    payload = await response.json();
  } catch {
    payload = null;
  }

  return {
    status: response.status,
    payload
  };
}

before(async () => {
  originalQuery = appDb.query;
  savedQueries = new Map();
  savedQueryCounter = 0;

  appDb.query = async (sql, params = []) => {
    const normalized = normalizeSql(sql);

    if (normalized === "select id from data_sources where id = $1") {
      const [id] = params;
      if (id === DATA_SOURCE_ID || id === OTHER_SOURCE_ID) {
        return { rowCount: 1, rows: [{ id }] };
      }
      return { rowCount: 0, rows: [] };
    }

    if (normalized.startsWith("insert into saved_queries")) {
      const [ownerId, name, description, dataSourceId, querySql, defaultRunParamsJson] = params;
      const duplicate = [...savedQueries.values()].find((entry) => (
        entry.owner_id === ownerId
        && entry.data_source_id === dataSourceId
        && entry.name.toLowerCase() === String(name).toLowerCase()
      ));
      if (duplicate) {
        throw duplicateError();
      }

      const now = new Date().toISOString();
      const row = {
        id: nextSavedQueryId(),
        owner_id: ownerId,
        name,
        description,
        data_source_id: dataSourceId,
        sql: querySql,
        default_run_params: JSON.parse(defaultRunParamsJson),
        created_at: now,
        updated_at: now
      };
      savedQueries.set(row.id, row);
      return { rowCount: 1, rows: [row] };
    }

    if (normalized.startsWith("select id, owner_id, name, description, data_source_id, sql, default_run_params, created_at, updated_at from saved_queries where ($1::uuid is null or data_source_id = $1::uuid)")) {
      const [dataSourceId] = params;
      const rows = sortSavedQueries(
        [...savedQueries.values()].filter((entry) => !dataSourceId || entry.data_source_id === dataSourceId)
      );
      return { rowCount: rows.length, rows };
    }

    if (normalized.startsWith("select id, owner_id, name, description, data_source_id, sql, default_run_params, created_at, updated_at from saved_queries where id = $1")) {
      const [id] = params;
      const row = savedQueries.get(id);
      return row ? { rowCount: 1, rows: [row] } : { rowCount: 0, rows: [] };
    }

    if (normalized.startsWith("update saved_queries set")) {
      const [id, name, description, dataSourceId, querySql, defaultRunParamsJson] = params;
      const existing = savedQueries.get(id);
      if (!existing) {
        return { rowCount: 0, rows: [] };
      }

      const duplicate = [...savedQueries.values()].find((entry) => (
        entry.id !== id
        && entry.owner_id === existing.owner_id
        && entry.data_source_id === dataSourceId
        && entry.name.toLowerCase() === String(name).toLowerCase()
      ));
      if (duplicate) {
        throw duplicateError();
      }

      const updated = {
        ...existing,
        name,
        description,
        data_source_id: dataSourceId,
        sql: querySql,
        default_run_params: JSON.parse(defaultRunParamsJson),
        updated_at: new Date().toISOString()
      };
      savedQueries.set(id, updated);
      return { rowCount: 1, rows: [updated] };
    }

    if (normalized.startsWith("delete from saved_queries where id = $1 returning id")) {
      const [id] = params;
      const existing = savedQueries.get(id);
      if (!existing) {
        return { rowCount: 0, rows: [] };
      }

      savedQueries.delete(id);
      return { rowCount: 1, rows: [{ id }] };
    }

    throw new Error(`Unexpected SQL in test stub: ${normalized}`);
  };

  delete require.cache[require.resolve("../src/server")];
  const { startServer } = require("../src/server");
  server = await startServer();
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

beforeEach(() => {
  savedQueries.clear();
  savedQueryCounter = 0;
});

after(async () => {
  await new Promise((resolve, reject) => {
    server.close((err) => (err ? reject(err) : resolve()));
  });

  appDb.query = originalQuery;
});

test("saved queries create/list/get/update/delete happy path", async () => {
  const create = await api("POST", "/v1/saved-queries", {
    name: "  Revenue by Month  ",
    description: "  Monthly summary  ",
    data_source_id: DATA_SOURCE_ID,
    sql: "  SELECT * FROM revenue  ",
    default_run_params: {
      llm_provider: "openai",
      model: "gpt-4.1-mini",
      max_rows: 500,
      timeout_ms: 30000,
      no_execute: false
    }
  }, "alice");

  assert.equal(create.status, 201);
  assert.equal(create.payload.owner_id, "alice");
  assert.equal(create.payload.name, "Revenue by Month");
  assert.equal(create.payload.description, "Monthly summary");
  assert.equal(create.payload.sql, "SELECT * FROM revenue");
  assert.deepEqual(create.payload.default_run_params, {
    llm_provider: "openai",
    model: "gpt-4.1-mini",
    max_rows: 500,
    timeout_ms: 30000,
    no_execute: false
  });

  const savedQueryId = create.payload.id;

  const list = await api("GET", "/v1/saved-queries", undefined, "bob");
  assert.equal(list.status, 200);
  assert.equal(list.payload.items.length, 1);
  assert.equal(list.payload.items[0].id, savedQueryId);

  const getById = await api("GET", `/v1/saved-queries/${savedQueryId}`, undefined, "bob");
  assert.equal(getById.status, 200);
  assert.equal(getById.payload.id, savedQueryId);
  assert.equal(getById.payload.owner_id, "alice");

  const update = await api("PUT", `/v1/saved-queries/${savedQueryId}`, {
    name: "Revenue by Region",
    description: "Regional revenue summary",
    data_source_id: OTHER_SOURCE_ID,
    sql: "SELECT region, SUM(amount) FROM revenue GROUP BY region",
    default_run_params: {
      model: "gpt-4.1-mini",
      no_execute: true
    }
  }, "bob");
  assert.equal(update.status, 200);
  assert.equal(update.payload.owner_id, "alice");
  assert.equal(update.payload.data_source_id, OTHER_SOURCE_ID);
  assert.deepEqual(update.payload.default_run_params, {
    model: "gpt-4.1-mini",
    no_execute: true
  });

  const filteredList = await api("GET", `/v1/saved-queries?data_source_id=${OTHER_SOURCE_ID}`, undefined, "carol");
  assert.equal(filteredList.status, 200);
  assert.equal(filteredList.payload.items.length, 1);
  assert.equal(filteredList.payload.items[0].id, savedQueryId);

  const del = await api("DELETE", `/v1/saved-queries/${savedQueryId}`, undefined, "dave");
  assert.equal(del.status, 200);
  assert.deepEqual(del.payload, { ok: true, id: savedQueryId });

  const listAfterDelete = await api("GET", "/v1/saved-queries", undefined, "erin");
  assert.equal(listAfterDelete.status, 200);
  assert.equal(listAfterDelete.payload.items.length, 0);
});

test("saved queries are publicly readable and openly writable", async () => {
  const created = await api("POST", "/v1/saved-queries", {
    name: "Store Revenue",
    data_source_id: DATA_SOURCE_ID,
    sql: "SELECT * FROM store_revenue"
  }, "owner-a");

  const savedQueryId = created.payload.id;

  const fetchedByOtherUser = await api("GET", `/v1/saved-queries/${savedQueryId}`, undefined, "owner-b");
  assert.equal(fetchedByOtherUser.status, 200);
  assert.equal(fetchedByOtherUser.payload.owner_id, "owner-a");

  const updatedByOtherUser = await api("PUT", `/v1/saved-queries/${savedQueryId}`, {
    name: "Store Revenue Updated",
    data_source_id: DATA_SOURCE_ID,
    sql: "SELECT store_id, revenue FROM store_revenue",
    description: "updated by another user"
  }, "owner-b");
  assert.equal(updatedByOtherUser.status, 200);
  assert.equal(updatedByOtherUser.payload.owner_id, "owner-a");

  const deletedByOtherUser = await api("DELETE", `/v1/saved-queries/${savedQueryId}`, undefined, "owner-c");
  assert.equal(deletedByOtherUser.status, 200);
});

test("saved query duplicate names are rejected per owner and data source", async () => {
  const first = await api("POST", "/v1/saved-queries", {
    name: "Revenue",
    data_source_id: DATA_SOURCE_ID,
    sql: "SELECT 1"
  }, "alice");
  assert.equal(first.status, 201);

  const sameOwnerConflict = await api("POST", "/v1/saved-queries", {
    name: " revenue ",
    data_source_id: DATA_SOURCE_ID,
    sql: "SELECT 2"
  }, "alice");
  assert.equal(sameOwnerConflict.status, 409);
  assert.equal(sameOwnerConflict.payload.error, "conflict");

  const differentOwnerAllowed = await api("POST", "/v1/saved-queries", {
    name: "Revenue",
    data_source_id: DATA_SOURCE_ID,
    sql: "SELECT 3"
  }, "bob");
  assert.equal(differentOwnerAllowed.status, 201);

  const differentDataSourceAllowed = await api("POST", "/v1/saved-queries", {
    name: "Revenue",
    data_source_id: OTHER_SOURCE_ID,
    sql: "SELECT 4"
  }, "alice");
  assert.equal(differentDataSourceAllowed.status, 201);
});

test("saved query validation returns 400", async () => {
  const missingFields = await api("POST", "/v1/saved-queries", {
    name: "   ",
    data_source_id: DATA_SOURCE_ID,
    sql: "  "
  });
  assert.equal(missingFields.status, 400);

  const invalidCreateSource = await api("POST", "/v1/saved-queries", {
    name: "Revenue",
    data_source_id: "not-a-uuid",
    sql: "SELECT 1"
  });
  assert.equal(invalidCreateSource.status, 400);

  const invalidListSource = await api("GET", "/v1/saved-queries?data_source_id=not-a-uuid");
  assert.equal(invalidListSource.status, 400);

  const invalidGetId = await api("GET", "/v1/saved-queries/not-a-uuid");
  assert.equal(invalidGetId.status, 400);

  const invalidDeleteId = await api("DELETE", "/v1/saved-queries/not-a-uuid");
  assert.equal(invalidDeleteId.status, 400);

  const invalidDefaultParamsType = await api("POST", "/v1/saved-queries", {
    name: "Revenue",
    data_source_id: DATA_SOURCE_ID,
    sql: "SELECT 1",
    default_run_params: []
  });
  assert.equal(invalidDefaultParamsType.status, 400);

  const invalidDefaultParamKey = await api("POST", "/v1/saved-queries", {
    name: "Revenue",
    data_source_id: DATA_SOURCE_ID,
    sql: "SELECT 1",
    default_run_params: {
      unexpected: true
    }
  });
  assert.equal(invalidDefaultParamKey.status, 400);

  const invalidDefaultParamValue = await api("POST", "/v1/saved-queries", {
    name: "Revenue",
    data_source_id: DATA_SOURCE_ID,
    sql: "SELECT 1",
    default_run_params: {
      max_rows: 0
    }
  });
  assert.equal(invalidDefaultParamValue.status, 400);
});

test("saved query not found paths return 404", async () => {
  const missingDataSource = await api("POST", "/v1/saved-queries", {
    name: "Revenue",
    data_source_id: MISSING_SOURCE_ID,
    sql: "SELECT 1"
  });
  assert.equal(missingDataSource.status, 404);

  const missingGet = await api("GET", "/v1/saved-queries/00000000-0000-4000-8000-000000009997");
  assert.equal(missingGet.status, 404);

  const missingUpdate = await api("PUT", "/v1/saved-queries/00000000-0000-4000-8000-000000009998", {
    name: "Revenue",
    data_source_id: DATA_SOURCE_ID,
    sql: "SELECT 1"
  });
  assert.equal(missingUpdate.status, 404);

  const missingDelete = await api("DELETE", "/v1/saved-queries/00000000-0000-4000-8000-000000009999");
  assert.equal(missingDelete.status, 404);
});
