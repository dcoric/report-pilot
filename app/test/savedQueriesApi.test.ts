import "./helpers/setupEnv";
import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";

process.env.DATABASE_URL = process.env.DATABASE_URL || "postgresql://test:test@localhost:5432/test";
process.env.PORT = "0";
process.env.AUTH_COOKIE_SECURE = "false";

import appDb = require("../src/lib/appDb");
import dbAdapterFactory = require("../src/adapters/dbAdapterFactory");
import { createAuthTestStub } from "./helpers/authTestStub";
import type { SavedQueryRow } from "../src/services/savedQueryService";
import type { SavedQueryVersionRow } from "../src/services/savedQueryVersionService";

interface ShareRow {
  saved_query_id: string;
  user_id: string;
  permission: "view" | "run";
  granted_by_user_id: string | null;
  created_at: string;
}

interface TestUserFixture {
  id: string;
  cookie: string;
  role: string;
}

interface AdapterCall {
  type: string;
  sql?: string;
  params?: Record<string, unknown>;
  parameterSchema?: unknown;
  opts?: unknown;
}

interface TestPayload extends Partial<SavedQueryRow> {
  items: TestPayload[];
  columns: string[];
  rows: Array<Record<string, unknown>>;
  row_count: number;
  error: string;
  shares: ShareRow[];
  diff: { removed: ShareRow[] };
  new_version: SavedQueryVersionRow;
  saved_query: TestPayload;
  restored_from_version_number: number;
  version_number: number;
  change_summary: string | null;
}

const DATA_SOURCE_ID = "00000000-0000-4000-8000-000000000111";
const OTHER_SOURCE_ID = "00000000-0000-4000-8000-000000000222";
const MISSING_SOURCE_ID = "00000000-0000-4000-8000-000000009999";

let server: import("http").Server;
let baseUrl: string;
let savedQueries: Map<string, SavedQueryRow>;
let savedQueryShares: Map<string, ShareRow>;
let savedQueryVersions: Map<string, SavedQueryVersionRow>;
let savedQueryCounter: number;
let savedQueryVersionCounter: number;
let originalQuery: typeof appDb.query;
let originalCreateDatabaseAdapter: typeof dbAdapterFactory.createDatabaseAdapter;
let originalIsSupportedDbType: typeof dbAdapterFactory.isSupportedDbType;
let adapterCalls: AdapterCall[];
let authStub: import("./helpers/authTestStub").AuthTestStub;
const testUsers: Record<string, TestUserFixture> = {};

function shareKey(savedQueryId: string, userId: string): string {
  return `${savedQueryId}::${userId}`;
}

function nextVersionId() {
  savedQueryVersionCounter += 1;
  return `00000000-0000-4000-8000-cccc${String(savedQueryVersionCounter).padStart(8, "0")}`;
}

function normalizeSql(sql: string): string {
  return String(sql).replace(/\s+/g, " ").trim().toLowerCase();
}

function nextSavedQueryId() {
  savedQueryCounter += 1;
  return `00000000-0000-4000-8000-${String(savedQueryCounter).padStart(12, "0")}`;
}

function duplicateError() {
  const err = new Error("duplicate key value violates unique constraint");
  (err as { code?: string }).code = "23505";
  return err;
}

function sortSavedQueries(rows: SavedQueryRow[]): SavedQueryRow[] {
  return [...rows].sort((a, b) => {
    const updatedDiff = new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime();
    if (updatedDiff !== 0) {
      return updatedDiff;
    }
    return new Date(b.created_at).getTime() - new Date(a.created_at).getTime();
  });
}

function ensureTestUser(label: string, role = "analyst"): TestUserFixture {
  if (testUsers[label]) {
    return testUsers[label];
  }
  const user = authStub.seedUser({
    email: `${label}@example.com`,
    roles: [role],
    dataSourceAccess: [DATA_SOURCE_ID, OTHER_SOURCE_ID]
  });
  const cookie = authStub.cookieFor(authStub.seedSession(user.id).token);
  testUsers[label] = { id: user.id, cookie, role };
  return testUsers[label];
}

function userId(label: string): string {
  return ensureTestUser(label).id;
}

async function api<T = TestPayload>(method: string, path: string, body?: unknown, label: string | null = "test-user", { role = "analyst" }: { role?: string } = {}) {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (label !== null) {
    const fixture = ensureTestUser(label, role);
    headers.Cookie = fixture.cookie;
  }
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined
  });

  let payload: unknown = null;
  try {
    payload = await response.json();
  } catch {
    payload = null;
  }

  return {
    status: response.status,
    payload: payload as T
  };
}

before(async () => {
  originalQuery = appDb.query;
  originalCreateDatabaseAdapter = dbAdapterFactory.createDatabaseAdapter;
  originalIsSupportedDbType = dbAdapterFactory.isSupportedDbType;
  savedQueries = new Map();
  savedQueryShares = new Map();
  savedQueryVersions = new Map();
  savedQueryCounter = 0;
  savedQueryVersionCounter = 0;
  adapterCalls = [];
  authStub = createAuthTestStub();

  (dbAdapterFactory as { createDatabaseAdapter: typeof dbAdapterFactory.createDatabaseAdapter }).createDatabaseAdapter = (() => ({
    async validateSql(sql: string) {
      adapterCalls.push({ type: "validateSql", sql });
      return { ok: true, errors: [], refs: [] };
    },
    async executeParameterizedReadOnly(sql: string, params: Record<string, unknown>, parameterSchema: unknown, opts: unknown) {
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
  })) as unknown as typeof dbAdapterFactory.createDatabaseAdapter;
  (dbAdapterFactory as { isSupportedDbType: typeof dbAdapterFactory.isSupportedDbType }).isSupportedDbType = (dbType: string) => dbType === "postgres" || dbType === "mssql";

  appDb.query = (async (sql: string, params: unknown[] = []) => {
    const auth = authStub.handleSql(sql, params);
    if (auth) return auth;

    const normalized = normalizeSql(sql);

    if (normalized === "select id from data_sources where id = $1") {
      const [id] = params as [string];
      if (id === DATA_SOURCE_ID || id === OTHER_SOURCE_ID) {
        return { rowCount: 1, rows: [{ id }] };
      }
      return { rowCount: 0, rows: [] };
    }

    if (normalized === "select data_source_id from saved_queries where id = $1") {
      const [id] = params as [string];
      const row = savedQueries.get(id);
      return row
        ? { rowCount: 1, rows: [{ data_source_id: row.data_source_id }] }
        : { rowCount: 0, rows: [] };
    }

    if (normalized.startsWith("insert into saved_queries")) {
      const [ownerId, name, description, dataSourceId, querySql, defaultRunParamsJson, parameterSchemaJson, tags, visibility] = params as [string, string, string | null, string, string, string, string, string[], SavedQueryRow["visibility"]];
      const duplicate = [...savedQueries.values()].find((entry) => (
        entry.owner_id === ownerId
        && entry.data_source_id === dataSourceId
        && entry.name.toLowerCase() === String(name).toLowerCase()
      ));
      if (duplicate) {
        throw duplicateError();
      }

      const now = new Date().toISOString();
      const row: SavedQueryRow = {
        id: nextSavedQueryId(),
        owner_id: ownerId,
        name,
        description,
        data_source_id: dataSourceId,
        sql: querySql,
        default_run_params: JSON.parse(defaultRunParamsJson) as Record<string, unknown>,
        parameter_schema: JSON.parse(parameterSchemaJson) as SavedQueryRow["parameter_schema"],
        tags: Array.isArray(tags) ? tags : [],
        visibility: visibility || "private",
        folder_id: null,
        created_at: now,
        updated_at: now
      };
      savedQueries.set(row.id, row);
      return { rowCount: 1, rows: [row] };
    }

    // Caller-aware list (the new QUERY-006 variant) — restricts to
    // owner + visibility='shared' + explicit grant.
    if (normalized.startsWith("select id, owner_id, name, description, data_source_id, sql, default_run_params, parameter_schema, tags, visibility, folder_id, created_at, updated_at from saved_queries sq where ($1::uuid is null or sq.data_source_id = $1::uuid)")) {
      const [dataSourceId, tagFilter, callerUserId] = params as [string | null, string | null, string];
      const rows = sortSavedQueries(
        [...savedQueries.values()].filter((entry) => {
          if (dataSourceId && entry.data_source_id !== dataSourceId) return false;
          if (tagFilter && !(entry.tags || []).includes(tagFilter)) return false;
          if (entry.owner_id === callerUserId) return true;
          if (entry.visibility === "shared") return true;
          if (savedQueryShares.has(shareKey(entry.id, callerUserId))) return true;
          return false;
        })
      );
      return { rowCount: rows.length, rows };
    }

    if (normalized.startsWith("select id, owner_id, name, description, data_source_id, sql, default_run_params, parameter_schema, tags, visibility, folder_id, created_at, updated_at from saved_queries where ($1::uuid is null or data_source_id = $1::uuid)")) {
      const [dataSourceId, tagFilter] = params as [string | null, string | null];
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

    if (normalized.startsWith("select id, owner_id, name, description, data_source_id, sql, default_run_params, parameter_schema, tags, visibility, folder_id, created_at, updated_at from saved_queries where id = $1")) {
      const [id] = params as [string];
      const row = savedQueries.get(id);
      return row ? { rowCount: 1, rows: [row] } : { rowCount: 0, rows: [] };
    }

    if (normalized.startsWith("select sq.id, sq.owner_id, sq.name, sq.description, sq.data_source_id, sq.sql, sq.default_run_params, sq.parameter_schema, sq.tags, sq.visibility, sq.created_at, sq.updated_at, ds.connection_ref, ds.db_type from saved_queries sq join data_sources ds on ds.id = sq.data_source_id where sq.id = $1")) {
      const [id] = params as [string];
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
      // Two callers: the full update flow (9 params) and the visibility-only
      // toggle from shareSavedQuery (2 params: id + visibility).
      if (params.length === 2) {
        const [id, visibility] = params as [string, SavedQueryRow["visibility"]];
        const existing = savedQueries.get(id);
        if (!existing) return { rowCount: 0, rows: [] };
        const updated = { ...existing, visibility, updated_at: new Date().toISOString() };
        savedQueries.set(id, updated);
        return { rowCount: 1, rows: [updated] };
      }

      const [id, name, description, dataSourceId, querySql, defaultRunParamsJson, parameterSchemaJson, tags, visibility] = params as [string, string, string | null, string, string, string, string, string[], SavedQueryRow["visibility"]];
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
        default_run_params: JSON.parse(defaultRunParamsJson) as Record<string, unknown>,
        parameter_schema: JSON.parse(parameterSchemaJson) as SavedQueryRow["parameter_schema"],
        tags: Array.isArray(tags) ? tags : (existing.tags || []),
        visibility: visibility || existing.visibility || "private",
        updated_at: new Date().toISOString()
      };
      savedQueries.set(id, updated);
      return { rowCount: 1, rows: [updated] };
    }

    if (normalized.startsWith("delete from saved_queries where id = $1 returning id")) {
      const [id] = params as [string];
      const existing = savedQueries.get(id);
      if (!existing) {
        return { rowCount: 0, rows: [] };
      }

      savedQueries.delete(id);
      // Cascade clean-up of shares (matches the FK ON DELETE CASCADE).
      for (const key of [...savedQueryShares.keys()]) {
        if (key.startsWith(`${id}::`)) savedQueryShares.delete(key);
      }
      return { rowCount: 1, rows: [{ id }] };
    }

    if (normalized.startsWith("select permission from saved_query_shares where saved_query_id = $1 and user_id = $2")) {
      const [savedQueryId, userId2] = params as [string, string];
      const row = savedQueryShares.get(shareKey(savedQueryId, userId2));
      return row ? { rowCount: 1, rows: [row] } : { rowCount: 0, rows: [] };
    }

    if (normalized.startsWith("select saved_query_id, user_id, permission, granted_by_user_id, created_at from saved_query_shares where saved_query_id = $1")) {
      const [savedQueryId] = params as [string];
      const rows = [...savedQueryShares.values()]
        .filter((row) => row.saved_query_id === savedQueryId)
        .sort((a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime());
      return { rowCount: rows.length, rows };
    }

    if (normalized.startsWith("delete from saved_query_shares where saved_query_id = $1 and user_id = any($2::uuid[])")) {
      const [savedQueryId, userIds] = params as [string, string[]];
      for (const uid of userIds) savedQueryShares.delete(shareKey(savedQueryId, uid));
      return { rowCount: userIds.length, rows: [] };
    }

    if (normalized.startsWith("insert into saved_query_shares")) {
      const [savedQueryId, userId2, permission, grantedBy] = params as [string, string, ShareRow["permission"], string | null];
      const now = new Date().toISOString();
      const existing = savedQueryShares.get(shareKey(savedQueryId, userId2));
      const row: ShareRow = {
        saved_query_id: savedQueryId,
        user_id: userId2,
        permission,
        granted_by_user_id: grantedBy,
        created_at: existing ? existing.created_at : now
      };
      savedQueryShares.set(shareKey(savedQueryId, userId2), row);
      return { rowCount: 1, rows: [row] };
    }

    if (normalized.startsWith("insert into auth_audit_log")) {
      return { rowCount: 1, rows: [] };
    }

    if (normalized.startsWith("select coalesce(max(version_number), 0) as max_version from saved_query_versions where saved_query_id = $1")) {
      const [savedQueryId] = params as [string];
      const maxVersion = [...savedQueryVersions.values()]
        .filter((row) => row.saved_query_id === savedQueryId)
        .reduce((max, row) => Math.max(max, row.version_number), 0);
      return { rowCount: 1, rows: [{ max_version: maxVersion }] };
    }

    if (normalized.startsWith("insert into saved_query_versions")) {
      const [
        savedQueryId,
        versionNumber,
        name,
        description,
        dataSourceId,
        sqlText,
        defaultRunParamsJson,
        parameterSchemaJson,
        tags,
        visibility,
        changeSummary,
        createdByUserId
      ] = params as [string, number, string, string | null, string, string, string, string, string[], SavedQueryRow["visibility"], string | null, string | null];
      // Mirror the UNIQUE (saved_query_id, version_number) constraint.
      const duplicate = [...savedQueryVersions.values()].some(
        (row) => row.saved_query_id === savedQueryId && row.version_number === versionNumber
      );
      if (duplicate) {
        throw duplicateError();
      }
      const now = new Date().toISOString();
      const row: SavedQueryVersionRow = {
        id: nextVersionId(),
        saved_query_id: savedQueryId,
        version_number: versionNumber,
        name,
        description,
        data_source_id: dataSourceId,
        sql: sqlText,
        default_run_params: JSON.parse(defaultRunParamsJson) as Record<string, unknown>,
        parameter_schema: JSON.parse(parameterSchemaJson) as SavedQueryVersionRow["parameter_schema"],
        tags: Array.isArray(tags) ? tags : [],
        visibility: visibility || "private",
        change_summary: changeSummary,
        created_by_user_id: createdByUserId,
        created_at: now
      };
      savedQueryVersions.set(row.id, row);
      return { rowCount: 1, rows: [row] };
    }

    if (normalized.startsWith("select id, saved_query_id, version_number, name, description, data_source_id, sql, default_run_params, parameter_schema, tags, visibility, change_summary, created_by_user_id, created_at from saved_query_versions where saved_query_id = $1")) {
      const [savedQueryId] = params as [string];
      const rows = [...savedQueryVersions.values()]
        .filter((row) => row.saved_query_id === savedQueryId)
        .sort((a, b) => b.version_number - a.version_number);
      return { rowCount: rows.length, rows };
    }

    if (normalized.startsWith("select id, saved_query_id, version_number, name, description, data_source_id, sql, default_run_params, parameter_schema, tags, visibility, change_summary, created_by_user_id, created_at from saved_query_versions where id = $1")) {
      const [id] = params as [string];
      const row = savedQueryVersions.get(id);
      return row ? { rowCount: 1, rows: [row] } : { rowCount: 0, rows: [] };
    }

    throw new Error(`Unexpected SQL in test stub: ${normalized}`);
  }) as unknown as typeof appDb.query;

  delete require.cache[require.resolve("../src/server")];
  const { startServer } = require("../src/server");
  server = await startServer();
  baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});

beforeEach(() => {
  savedQueries.clear();
  savedQueryShares.clear();
  savedQueryVersions.clear();
  savedQueryCounter = 0;
  savedQueryVersionCounter = 0;
  adapterCalls = [];
});

after(async () => {
  await new Promise<void>((resolve, reject) => {
    server.close((err) => (err ? reject(err) : resolve()));
  });

  appDb.query = originalQuery;
  (dbAdapterFactory as { createDatabaseAdapter: typeof dbAdapterFactory.createDatabaseAdapter }).createDatabaseAdapter = originalCreateDatabaseAdapter;
  (dbAdapterFactory as { isSupportedDbType: typeof dbAdapterFactory.isSupportedDbType }).isSupportedDbType = originalIsSupportedDbType;
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
  assert.equal(create.payload.owner_id, userId("alice"));
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

  const list = await api("GET", "/v1/saved-queries", undefined, "alice");
  assert.equal(list.status, 200);
  assert.equal(list.payload.items.length, 1);
  assert.equal(list.payload.items[0].id, savedQueryId);

  const getById = await api("GET", `/v1/saved-queries/${savedQueryId}`, undefined, "alice");
  assert.equal(getById.status, 200);
  assert.equal(getById.payload.id, savedQueryId);
  assert.equal(getById.payload.owner_id, userId("alice"));

  const update = await api("PUT", `/v1/saved-queries/${savedQueryId}`, {
    name: "Revenue by Region",
    description: "Regional revenue summary",
    data_source_id: OTHER_SOURCE_ID,
    sql: "SELECT region, SUM(amount) FROM revenue GROUP BY region",
    default_run_params: {
      model: "gpt-4.1-mini",
      no_execute: true
    }
  }, "alice");
  assert.equal(update.status, 200);
  assert.equal(update.payload.owner_id, userId("alice"));
  assert.equal(update.payload.data_source_id, OTHER_SOURCE_ID);
  assert.deepEqual(update.payload.default_run_params, {
    model: "gpt-4.1-mini",
    no_execute: true
  });
  assert.deepEqual(update.payload.parameter_schema, []);

  const filteredList = await api("GET", `/v1/saved-queries?data_source_id=${OTHER_SOURCE_ID}`, undefined, "alice");
  assert.equal(filteredList.status, 200);
  assert.equal(filteredList.payload.items.length, 1);
  assert.equal(filteredList.payload.items[0].id, savedQueryId);

  const del = await api("DELETE", `/v1/saved-queries/${savedQueryId}`, undefined, "alice");
  assert.equal(del.status, 200);
  assert.deepEqual(del.payload, { ok: true, id: savedQueryId });

  const listAfterDelete = await api("GET", "/v1/saved-queries", undefined, "erin");
  assert.equal(listAfterDelete.status, 200);
  assert.equal(listAfterDelete.payload.items.length, 0);
});

test("QUERY-006 private saved queries are hidden from non-owners and write-protected", async () => {
  const created = await api("POST", "/v1/saved-queries", {
    name: "Store Revenue",
    data_source_id: DATA_SOURCE_ID,
    sql: "SELECT * FROM store_revenue"
  }, "owner-a");
  assert.equal(created.status, 201);
  assert.equal(created.payload.visibility, "private");

  const savedQueryId = created.payload.id;

  const fetchedByOtherUser = await api("GET", `/v1/saved-queries/${savedQueryId}`, undefined, "owner-b");
  assert.equal(fetchedByOtherUser.status, 403);

  const listFromStranger = await api("GET", "/v1/saved-queries", undefined, "owner-b");
  assert.equal(listFromStranger.status, 200);
  assert.equal(listFromStranger.payload.items.length, 0);

  const updateByOther = await api("PUT", `/v1/saved-queries/${savedQueryId}`, {
    name: "Stolen",
    data_source_id: DATA_SOURCE_ID,
    sql: "SELECT 1"
  }, "owner-b");
  assert.equal(updateByOther.status, 403);

  const deletedByOther = await api("DELETE", `/v1/saved-queries/${savedQueryId}`, undefined, "owner-b");
  assert.equal(deletedByOther.status, 403);
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
  assert.ok(run.payload.sql);
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

test("QUERY-006 visibility='shared' surfaces queries to other authenticated users (read-only)", async () => {
  const created = await api("POST", "/v1/saved-queries", {
    name: "Org Revenue",
    data_source_id: DATA_SOURCE_ID,
    sql: "SELECT * FROM revenue",
    visibility: "shared"
  }, "owner-x");
  assert.equal(created.status, 201);
  assert.equal(created.payload.visibility, "shared");

  const id = created.payload.id;

  // Other user can list + GET it.
  const listForOther = await api("GET", "/v1/saved-queries", undefined, "viewer-y");
  assert.equal(listForOther.status, 200);
  assert.equal(listForOther.payload.items.length, 1);
  assert.equal(listForOther.payload.items[0].id, id);

  const getForOther = await api("GET", `/v1/saved-queries/${id}`, undefined, "viewer-y");
  assert.equal(getForOther.status, 200);

  // But cannot edit, delete, or share.
  const updateByOther = await api("PUT", `/v1/saved-queries/${id}`, {
    name: "Hijacked",
    data_source_id: DATA_SOURCE_ID,
    sql: "SELECT 0"
  }, "viewer-y");
  assert.equal(updateByOther.status, 403);

  const deleteByOther = await api("DELETE", `/v1/saved-queries/${id}`, undefined, "viewer-y");
  assert.equal(deleteByOther.status, 403);

  const shareByOther = await api("POST", `/v1/saved-queries/${id}/share`, {
    visibility: "private"
  }, "viewer-y");
  assert.equal(shareByOther.status, 403);
});

test("QUERY-006 explicit per-user share with 'view' permission cannot run", async () => {
  const created = await api("POST", "/v1/saved-queries", {
    name: "Limited Revenue",
    data_source_id: DATA_SOURCE_ID,
    sql: "SELECT 1"
  }, "owner-share");
  const id = created.payload.id;
  const recipient = ensureTestUser("viewer-recipient");

  const share = await api("POST", `/v1/saved-queries/${id}/share`, {
    shares: [{ user_id: recipient.id, permission: "view" }]
  }, "owner-share");
  assert.equal(share.status, 200);
  assert.equal(share.payload.shares.length, 1);
  assert.equal(share.payload.shares[0].user_id, recipient.id);
  assert.equal(share.payload.shares[0].permission, "view");

  const recipientSees = await api("GET", `/v1/saved-queries/${id}`, undefined, "viewer-recipient");
  assert.equal(recipientSees.status, 200);

  const recipientRuns = await api("POST", `/v1/saved-queries/${id}/run`, {
    params: {}
  }, "viewer-recipient");
  assert.equal(recipientRuns.status, 403);

  const strangerSees = await api("GET", `/v1/saved-queries/${id}`, undefined, "stranger");
  assert.equal(strangerSees.status, 403);
});

test("QUERY-006 explicit 'run' share lets recipient execute; revoke removes both rights", async () => {
  const created = await api("POST", "/v1/saved-queries", {
    name: "Runnable Revenue",
    data_source_id: DATA_SOURCE_ID,
    sql: "SELECT 1"
  }, "owner-run");
  const id = created.payload.id;
  const recipient = ensureTestUser("runner-recipient");

  const grant = await api("POST", `/v1/saved-queries/${id}/share`, {
    shares: [{ user_id: recipient.id, permission: "run" }]
  }, "owner-run");
  assert.equal(grant.status, 200);

  const recipientRuns = await api("POST", `/v1/saved-queries/${id}/run`, {
    params: {}
  }, "runner-recipient");
  assert.equal(recipientRuns.status, 200);
  assert.equal(recipientRuns.payload.row_count, 1);

  // Now revoke by sending an empty shares list.
  const revoke = await api("POST", `/v1/saved-queries/${id}/share`, {
    shares: []
  }, "owner-run");
  assert.equal(revoke.status, 200);
  assert.equal(revoke.payload.shares.length, 0);
  assert.equal(revoke.payload.diff.removed.length, 1);

  const recipientGets = await api("GET", `/v1/saved-queries/${id}`, undefined, "runner-recipient");
  assert.equal(recipientGets.status, 403);
});

test("QUERY-006 access endpoint exposes visibility + grants to owner; non-owners are forbidden", async () => {
  const created = await api("POST", "/v1/saved-queries", {
    name: "Access Test",
    data_source_id: DATA_SOURCE_ID,
    sql: "SELECT 1"
  }, "access-owner");
  const id = created.payload.id;
  const recipient = ensureTestUser("access-recipient");

  await api("POST", `/v1/saved-queries/${id}/share`, {
    visibility: "private",
    shares: [{ user_id: recipient.id, permission: "view" }]
  }, "access-owner");

  const ownerAccess = await api("GET", `/v1/saved-queries/${id}/access`, undefined, "access-owner");
  assert.equal(ownerAccess.status, 200);
  assert.equal(ownerAccess.payload.visibility, "private");
  assert.equal(ownerAccess.payload.owner_id, userId("access-owner"));
  assert.equal(ownerAccess.payload.shares.length, 1);
  assert.equal(ownerAccess.payload.shares[0].permission, "view");

  // Granted user can see the access summary (read access implies it).
  const recipientAccess = await api("GET", `/v1/saved-queries/${id}/access`, undefined, "access-recipient");
  assert.equal(recipientAccess.status, 200);

  // Stranger can't.
  const strangerAccess = await api("GET", `/v1/saved-queries/${id}/access`, undefined, "stranger-a");
  assert.equal(strangerAccess.status, 403);
});

test("QUERY-006 share endpoint validates the grant payload", async () => {
  const created = await api("POST", "/v1/saved-queries", {
    name: "Validate Share",
    data_source_id: DATA_SOURCE_ID,
    sql: "SELECT 1"
  }, "share-owner");
  const id = created.payload.id;

  const badVisibility = await api("POST", `/v1/saved-queries/${id}/share`, {
    visibility: "public"
  }, "share-owner");
  assert.equal(badVisibility.status, 400);

  const badPermission = await api("POST", `/v1/saved-queries/${id}/share`, {
    shares: [{ user_id: "00000000-0000-4000-8000-aaaa00000099", permission: "admin" }]
  }, "share-owner");
  assert.equal(badPermission.status, 400);

  const badUserId = await api("POST", `/v1/saved-queries/${id}/share`, {
    shares: [{ user_id: "not-a-uuid", permission: "view" }]
  }, "share-owner");
  assert.equal(badUserId.status, 400);
});

test("QUERY-005 create records version 1 and update appends a new version", async () => {
  const created = await api("POST", "/v1/saved-queries", {
    name: "Versioned Revenue",
    data_source_id: DATA_SOURCE_ID,
    sql: "SELECT 1"
  }, "version-owner");
  assert.equal(created.status, 201);
  const id = created.payload.id;

  const initialList = await api("GET", `/v1/saved-queries/${id}/versions`, undefined, "version-owner");
  assert.equal(initialList.status, 200);
  assert.equal(initialList.payload.items.length, 1);
  assert.equal(initialList.payload.items[0].version_number, 1);
  assert.equal(initialList.payload.items[0].change_summary, "created");
  assert.equal(initialList.payload.items[0].sql, "SELECT 1");

  const updated = await api("PUT", `/v1/saved-queries/${id}`, {
    name: "Versioned Revenue",
    data_source_id: DATA_SOURCE_ID,
    sql: "SELECT 2"
  }, "version-owner");
  assert.equal(updated.status, 200);

  const afterUpdate = await api("GET", `/v1/saved-queries/${id}/versions`, undefined, "version-owner");
  assert.equal(afterUpdate.status, 200);
  assert.equal(afterUpdate.payload.items.length, 2);
  // Listed newest-first.
  assert.equal(afterUpdate.payload.items[0].version_number, 2);
  assert.equal(afterUpdate.payload.items[0].sql, "SELECT 2");
  assert.equal(afterUpdate.payload.items[0].change_summary, "updated");
  assert.equal(afterUpdate.payload.items[1].version_number, 1);
  assert.equal(afterUpdate.payload.items[1].sql, "SELECT 1");
});

test("QUERY-005 owner can restore a previous version; restore itself is recorded", async () => {
  const created = await api("POST", "/v1/saved-queries", {
    name: "Restore Target",
    data_source_id: DATA_SOURCE_ID,
    sql: "SELECT 'v1'"
  }, "restore-owner");
  const id = created.payload.id;

  await api("PUT", `/v1/saved-queries/${id}`, {
    name: "Restore Target",
    data_source_id: DATA_SOURCE_ID,
    sql: "SELECT 'v2'"
  }, "restore-owner");

  const listBefore = await api("GET", `/v1/saved-queries/${id}/versions`, undefined, "restore-owner");
  assert.equal(listBefore.payload.items.length, 2);
  const v1 = listBefore.payload.items.find((row) => row.version_number === 1);
  assert.ok(v1, "expected version 1 to exist");

  const restore = await api("POST", `/v1/saved-queries/${id}/versions/${v1.id}/restore`, {}, "restore-owner");
  assert.equal(restore.status, 200);
  assert.equal(restore.payload.restored_from_version_number, 1);
  assert.equal(restore.payload.new_version.version_number, 3);
  assert.equal(restore.payload.saved_query.sql, "SELECT 'v1'");

  const finalGet = await api("GET", `/v1/saved-queries/${id}`, undefined, "restore-owner");
  assert.equal(finalGet.payload.sql, "SELECT 'v1'");

  const listAfter = await api("GET", `/v1/saved-queries/${id}/versions`, undefined, "restore-owner");
  assert.equal(listAfter.payload.items.length, 3);
  assert.equal(listAfter.payload.items[0].version_number, 3);
  assert.match(listAfter.payload.items[0].change_summary ?? "", /restored from version 1/);
});

test("QUERY-005 non-owner cannot restore a version; granted reader can list", async () => {
  const created = await api("POST", "/v1/saved-queries", {
    name: "Restricted Restore",
    data_source_id: DATA_SOURCE_ID,
    sql: "SELECT 1"
  }, "restore-owner-private");
  const id = created.payload.id;

  await api("PUT", `/v1/saved-queries/${id}`, {
    name: "Restricted Restore",
    data_source_id: DATA_SOURCE_ID,
    sql: "SELECT 2"
  }, "restore-owner-private");

  // Stranger cannot even list.
  const strangerList = await api("GET", `/v1/saved-queries/${id}/versions`, undefined, "stranger-restore");
  assert.equal(strangerList.status, 403);

  // Grant a view share to a teammate.
  const teammate = ensureTestUser("restore-teammate");
  await api("POST", `/v1/saved-queries/${id}/share`, {
    shares: [{ user_id: teammate.id, permission: "view" }]
  }, "restore-owner-private");

  const teammateList = await api("GET", `/v1/saved-queries/${id}/versions`, undefined, "restore-teammate");
  assert.equal(teammateList.status, 200);
  assert.equal(teammateList.payload.items.length, 2);

  // Teammate cannot restore, only the owner can.
  const target = teammateList.payload.items.find((row) => row.version_number === 1);
  assert.ok(target);
  const teammateRestore = await api("POST", `/v1/saved-queries/${id}/versions/${target.id}/restore`, {}, "restore-teammate");
  assert.equal(teammateRestore.status, 403);
});

test("QUERY-005 restoring with a mismatched or missing version returns 404", async () => {
  const created = await api("POST", "/v1/saved-queries", {
    name: "Mismatch",
    data_source_id: DATA_SOURCE_ID,
    sql: "SELECT 1"
  }, "mismatch-owner");
  const id = created.payload.id;

  const other = await api("POST", "/v1/saved-queries", {
    name: "Other",
    data_source_id: DATA_SOURCE_ID,
    sql: "SELECT 2"
  }, "mismatch-other-owner");
  const otherList = await api("GET", `/v1/saved-queries/${other.payload.id}/versions`, undefined, "mismatch-other-owner");
  const otherVersionId = otherList.payload.items[0].id;

  // Wrong saved_query_id for that version → 404.
  const crossed = await api("POST", `/v1/saved-queries/${id}/versions/${otherVersionId}/restore`, {}, "mismatch-owner");
  assert.equal(crossed.status, 404);

  // Unknown version id → 404.
  const missing = await api("POST", `/v1/saved-queries/${id}/versions/00000000-0000-4000-8000-cccc99999999/restore`, {}, "mismatch-owner");
  assert.equal(missing.status, 404);
});

test("QUERY-006 viewer role is denied by the share permission policy", async () => {
  const created = await api("POST", "/v1/saved-queries", {
    name: "Viewer Share",
    data_source_id: DATA_SOURCE_ID,
    sql: "SELECT 1"
  }, "viewer-share-owner", { role: "viewer" });
  // Viewers can't write saved queries, so creation itself is denied.
  assert.equal(created.status, 403);
});
