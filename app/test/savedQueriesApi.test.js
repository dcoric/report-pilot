const { test, before, after, beforeEach } = require("node:test");
const assert = require("node:assert/strict");

process.env.DATABASE_URL = process.env.DATABASE_URL || "postgresql://test:test@localhost:5432/test";
process.env.PORT = "0";

const appDb = require("../src/lib/appDb");
const dbAdapterFactory = require("../src/adapters/dbAdapterFactory");

const DATA_SOURCE_ID = "00000000-0000-4000-8000-000000000111";
const OTHER_SOURCE_ID = "00000000-0000-4000-8000-000000000222";
const MISSING_SOURCE_ID = "00000000-0000-4000-8000-000000009999";

let server;
let baseUrl;
let savedQueries;
let savedQueryCounter;
let originalQuery;
let originalCreateDatabaseAdapter;
let originalIsSupportedDbType;
let adapterCalls;

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
  originalCreateDatabaseAdapter = dbAdapterFactory.createDatabaseAdapter;
  originalIsSupportedDbType = dbAdapterFactory.isSupportedDbType;
  savedQueries = new Map();
  savedQueryCounter = 0;
  adapterCalls = [];

  dbAdapterFactory.createDatabaseAdapter = () => ({
    async validateSql(sql) {
      adapterCalls.push({ type: "validateSql", sql });
      return { ok: true, errors: [], refs: [] };
    },
    async executeParameterizedReadOnly(sql, params, parameterSchema, opts) {
      adapterCalls.push({ type: "executeParameterizedReadOnly", sql, params, parameterSchema, opts });
      return {
        columns: ["country", "total"],
        rows: [{ country: params.country || "US", total: 42 }],
        rowCount: 1,
        durationMs: 7
      };
    },
    async close() {
      adapterCalls.push({ type: "close" });
    }
  });
  dbAdapterFactory.isSupportedDbType = (dbType) => dbType === "postgres" || dbType === "mssql";

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
      const [ownerId, name, description, dataSourceId, querySql, defaultRunParamsJson, parameterSchemaJson, tags] = params;
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
        parameter_schema: JSON.parse(parameterSchemaJson),
        tags: Array.isArray(tags) ? tags : [],
        created_at: now,
        updated_at: now
      };
      savedQueries.set(row.id, row);
      return { rowCount: 1, rows: [row] };
    }

    if (normalized.startsWith("select id, owner_id, name, description, data_source_id, sql, default_run_params, parameter_schema, tags, created_at, updated_at from saved_queries where ($1::uuid is null or data_source_id = $1::uuid)")) {
      const [dataSourceId, tagFilter] = params;
      const rows = sortSavedQueries(
        [...savedQueries.values()].filter((entry) => {
          if (dataSourceId && entry.data_source_id !== dataSourceId) {
            return false;
          }
          if (tagFilter && !(entry.tags || []).includes(tagFilter)) {
            return false;
          }
          return true;
        })
      );
      return { rowCount: rows.length, rows };
    }

    if (normalized.startsWith("select id, owner_id, name, description, data_source_id, sql, default_run_params, parameter_schema, tags, created_at, updated_at from saved_queries where id = $1")) {
      const [id] = params;
      const row = savedQueries.get(id);
      return row ? { rowCount: 1, rows: [row] } : { rowCount: 0, rows: [] };
    }

    if (normalized.startsWith("select sq.id, sq.owner_id, sq.name, sq.description, sq.data_source_id, sq.sql, sq.default_run_params, sq.parameter_schema, sq.tags, sq.created_at, sq.updated_at, ds.connection_ref, ds.db_type from saved_queries sq join data_sources ds on ds.id = sq.data_source_id where sq.id = $1")) {
      const [id] = params;
      const row = savedQueries.get(id);
      if (!row) {
        return { rowCount: 0, rows: [] };
      }
      return {
        rowCount: 1,
        rows: [{
          ...row,
          connection_ref: "postgresql://example",
          db_type: "postgres"
        }]
      };
    }

    if (normalized.startsWith("select schema_name, object_name from schema_objects where data_source_id = $1 and is_ignored = false and object_type in ('table', 'view', 'materialized_view')")) {
      return { rowCount: 1, rows: [{ schema_name: "public", object_name: "revenue" }] };
    }

    if (normalized.startsWith("update saved_queries set")) {
      const [id, name, description, dataSourceId, querySql, defaultRunParamsJson, parameterSchemaJson, tags] = params;
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
        parameter_schema: JSON.parse(parameterSchemaJson),
        tags: Array.isArray(tags) ? tags : (existing.tags || []),
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
  adapterCalls = [];
});

after(async () => {
  await new Promise((resolve, reject) => {
    server.close((err) => (err ? reject(err) : resolve()));
  });

  appDb.query = originalQuery;
  dbAdapterFactory.createDatabaseAdapter = originalCreateDatabaseAdapter;
  dbAdapterFactory.isSupportedDbType = originalIsSupportedDbType;
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
  assert.deepEqual(create.payload.parameter_schema, []);

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
  assert.deepEqual(update.payload.parameter_schema, []);

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

test("saved queries auto-extract placeholders and preserve schema customizations on update", async () => {
  const created = await api("POST", "/v1/saved-queries", {
    name: "Revenue by Country",
    data_source_id: DATA_SOURCE_ID,
    sql: "SELECT * FROM revenue WHERE sold_at >= :start_date AND country = :country",
    parameter_schema: [
      { name: "start_date", type: "date", required: true, default: "2026-01-01" },
      { name: "country", type: "text", required: false, default: "US" }
    ]
  });

  assert.equal(created.status, 201);
  assert.deepEqual(created.payload.parameter_schema, [
    { name: "start_date", type: "date", required: true, default: "2026-01-01", allowed_values: null },
    { name: "country", type: "text", required: false, default: "US", allowed_values: null }
  ]);

  const updated = await api("PUT", `/v1/saved-queries/${created.payload.id}`, {
    name: "Revenue by Country",
    data_source_id: DATA_SOURCE_ID,
    sql: "SELECT * FROM revenue WHERE sold_at >= :start_date AND sold_at < :end_date AND country = :country"
  });

  assert.equal(updated.status, 200);
  assert.deepEqual(updated.payload.parameter_schema, [
    { name: "start_date", type: "date", required: true, default: "2026-01-01", allowed_values: null },
    { name: "end_date", type: "text", required: true, default: null, allowed_values: null },
    { name: "country", type: "text", required: false, default: "US", allowed_values: null }
  ]);
});

test("saved query validate-params and run use resolved parameter values", async () => {
  const created = await api("POST", "/v1/saved-queries", {
    name: "Revenue by Country",
    data_source_id: DATA_SOURCE_ID,
    sql: "SELECT country, SUM(amount) AS total FROM revenue WHERE sold_at >= :start_date AND country = :country GROUP BY country",
    default_run_params: {
      max_rows: 250,
      timeout_ms: 30000
    },
    parameter_schema: [
      { name: "start_date", type: "date", required: true, default: null },
      { name: "country", type: "text", required: false, default: "US", allowed_values: ["US", "CA"] }
    ]
  });
  assert.equal(created.status, 201);

  const validated = await api("POST", `/v1/saved-queries/${created.payload.id}/validate-params`, {
    params: {
      start_date: "2026-02-01"
    }
  });
  assert.equal(validated.status, 200);
  assert.deepEqual(validated.payload, {
    ok: true,
    resolved_values: {
      start_date: "2026-02-01",
      country: "US"
    }
  });

  const validationFailure = await api("POST", `/v1/saved-queries/${created.payload.id}/validate-params`, {
    params: {
      start_date: "bad-date",
      country: "BR"
    }
  });
  assert.equal(validationFailure.status, 200);
  assert.deepEqual(validationFailure.payload, {
    ok: false,
    errors: [
      { param: "start_date", message: "must be a valid date in YYYY-MM-DD format" },
      { param: "country", message: "must be one of the allowed values" }
    ]
  });

  const run = await api("POST", `/v1/saved-queries/${created.payload.id}/run`, {
    params: {
      start_date: "2026-02-01",
      country: "CA"
    },
    max_rows: 25,
    timeout_ms: 15000
  });

  assert.equal(run.status, 200);
  assert.match(run.payload.sql, /country = :country/i);
  assert.match(run.payload.sql, /\bLIMIT 25;$/i);
  assert.deepEqual(run.payload.columns, ["country", "total"]);
  assert.deepEqual(run.payload.rows, [{ country: "CA", total: 42 }]);
  assert.equal(run.payload.row_count, 1);

  assert.deepEqual(adapterCalls, [
    {
      type: "validateSql",
      sql: "SELECT country, SUM(amount) AS total FROM revenue WHERE sold_at >= '1900-01-01' AND country = 'x' GROUP BY country LIMIT 25;"
    },
    {
      type: "executeParameterizedReadOnly",
      sql: "SELECT country, SUM(amount) AS total FROM revenue WHERE sold_at >= :start_date AND country = :country GROUP BY country LIMIT 25;",
      params: {
        start_date: "2026-02-01",
        country: "CA"
      },
      parameterSchema: [
        { name: "start_date", type: "date", required: true, default: null, allowed_values: null },
        { name: "country", type: "text", required: false, default: "US", allowed_values: ["US", "CA"] }
      ],
      opts: {
        maxRows: 25,
        timeoutMs: 15000
      }
    },
    {
      type: "close"
    }
  ]);
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

  const invalidParameterSchema = await api("POST", "/v1/saved-queries", {
    name: "Revenue",
    data_source_id: DATA_SOURCE_ID,
    sql: "SELECT * FROM revenue WHERE sold_at >= :start_date",
    parameter_schema: [
      { name: "1start_date", type: "date" }
    ]
  });
  assert.equal(invalidParameterSchema.status, 400);
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

test("saved query tags are normalized, deduplicated, and filterable", async () => {
  const created = await api("POST", "/v1/saved-queries", {
    name: "Tagged Revenue",
    data_source_id: DATA_SOURCE_ID,
    sql: "SELECT 1",
    tags: [" Finance ", "finance", "REVENUE", "", "ops"]
  });
  assert.equal(created.status, 201);
  assert.deepEqual(created.payload.tags, ["finance", "revenue", "ops"]);

  const untagged = await api("POST", "/v1/saved-queries", {
    name: "Untagged Revenue",
    data_source_id: DATA_SOURCE_ID,
    sql: "SELECT 2"
  });
  assert.equal(untagged.status, 201);
  assert.deepEqual(untagged.payload.tags, []);

  const filtered = await api("GET", "/v1/saved-queries?tag=finance");
  assert.equal(filtered.status, 200);
  assert.equal(filtered.payload.items.length, 1);
  assert.equal(filtered.payload.items[0].id, created.payload.id);

  const updated = await api("PUT", `/v1/saved-queries/${created.payload.id}`, {
    name: "Tagged Revenue",
    data_source_id: DATA_SOURCE_ID,
    sql: "SELECT 1",
    tags: ["ops"]
  });
  assert.equal(updated.status, 200);
  assert.deepEqual(updated.payload.tags, ["ops"]);

  const updatePreservesTags = await api("PUT", `/v1/saved-queries/${created.payload.id}`, {
    name: "Tagged Revenue",
    data_source_id: DATA_SOURCE_ID,
    sql: "SELECT 1"
  });
  assert.equal(updatePreservesTags.status, 200);
  assert.deepEqual(updatePreservesTags.payload.tags, ["ops"]);

  const tagTooLong = await api("POST", "/v1/saved-queries", {
    name: "Bad Tags",
    data_source_id: DATA_SOURCE_ID,
    sql: "SELECT 1",
    tags: ["x".repeat(60)]
  });
  assert.equal(tagTooLong.status, 400);

  const wrongShape = await api("POST", "/v1/saved-queries", {
    name: "Bad Shape",
    data_source_id: DATA_SOURCE_ID,
    sql: "SELECT 1",
    tags: "finance"
  });
  assert.equal(wrongShape.status, 400);
});
