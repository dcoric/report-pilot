import "./helpers/setupEnv";
import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";

process.env.DATABASE_URL = process.env.DATABASE_URL || "postgresql://test:test@localhost:5432/test";
process.env.PORT = "0";
process.env.AUTH_COOKIE_SECURE = "false";

import appDb = require("../src/lib/appDb");
import dbAdapterFactory = require("../src/adapters/dbAdapterFactory");
import { createAuthTestStub } from "./helpers/authTestStub";

const DATA_SOURCE_ID = "00000000-0000-4000-8000-000000000111";

let server: import("http").Server;
let baseUrl: string;
let savedQueries;
let savedQueryVersions;
let folders;
let savedQueryCounter;
let folderCounter;
let savedQueryVersionCounter;
let originalQuery: typeof appDb.query;
let originalWithTransaction: typeof appDb.withTransaction;
let originalCreateDatabaseAdapter;
let originalIsSupportedDbType;
let authStub: import("./helpers/authTestStub").AuthTestStub;
const testUsers = {};

function nextSavedQueryId() {
  savedQueryCounter += 1;
  return `00000000-0000-4000-8000-${String(savedQueryCounter).padStart(12, "0")}`;
}

function nextFolderId() {
  folderCounter += 1;
  return `00000000-0000-4000-8000-ffff${String(folderCounter).padStart(8, "0")}`;
}

function nextVersionId() {
  savedQueryVersionCounter += 1;
  return `00000000-0000-4000-8000-cccc${String(savedQueryVersionCounter).padStart(8, "0")}`;
}

function normalizeSql(sql) {
  return String(sql).replace(/\s+/g, " ").trim().toLowerCase();
}

function duplicateError() {
  const err = new Error("duplicate key value violates unique constraint");
  (err as { code?: string }).code = "23505";
  return err;
}

function ensureTestUser(label, role = "analyst") {
  if (testUsers[label]) return testUsers[label];
  const user = authStub.seedUser({
    email: `${label}@example.com`,
    roles: [role],
    dataSourceAccess: [DATA_SOURCE_ID]
  });
  const cookie = authStub.cookieFor(authStub.seedSession(user.id).token);
  testUsers[label] = { id: user.id, cookie, role };
  return testUsers[label];
}

function userId(label) {
  return ensureTestUser(label).id;
}

async function api(method: string, path: string, body?: unknown, label: string | null = "test-user", { role = "analyst" }: { role?: string } = {}) {
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
  let payload = null;
  try {
    payload = await response.json();
  } catch {
    payload = null;
  }
  return { status: response.status, payload };
}

// In-memory implementation of the SQL surface area used by the folder
// service. We share the same `savedQueries` map so the move endpoint can
// flip the `folder_id` column.
function buildSqlHandler() {
  return async (sql, params = []) => {
    const auth = authStub.handleSql(sql, params);
    if (auth) return auth;

    const normalized = normalizeSql(sql);

    if (normalized === "select id from data_sources where id = $1") {
      const [id] = params;
      if (id === DATA_SOURCE_ID) return { rowCount: 1, rows: [{ id }] };
      return { rowCount: 0, rows: [] };
    }

    if (normalized === "select data_source_id from saved_queries where id = $1") {
      const [id] = params;
      const row = savedQueries.get(id);
      return row
        ? { rowCount: 1, rows: [{ data_source_id: row.data_source_id }] }
        : { rowCount: 0, rows: [] };
    }

    if (normalized === "select id, owner_id, folder_id from saved_queries where id = $1") {
      const [id] = params;
      const row = savedQueries.get(id);
      return row
        ? { rowCount: 1, rows: [{ id: row.id, owner_id: row.owner_id, folder_id: row.folder_id || null }] }
        : { rowCount: 0, rows: [] };
    }

    if (normalized.startsWith("insert into saved_queries")) {
      const [ownerId, name, description, dataSourceId, querySql, defaultRunParamsJson, parameterSchemaJson, tags, visibility] = params;
      const duplicate = [...savedQueries.values()].find((entry) => (
        entry.owner_id === ownerId
        && entry.data_source_id === dataSourceId
        && entry.name.toLowerCase() === String(name).toLowerCase()
      ));
      if (duplicate) throw duplicateError();
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
        visibility: visibility || "private",
        folder_id: null,
        created_at: now,
        updated_at: now
      };
      savedQueries.set(row.id, row);
      return { rowCount: 1, rows: [row] };
    }

    if (normalized.startsWith("select id, owner_id, name, description, data_source_id, sql, default_run_params, parameter_schema, tags, visibility, folder_id, created_at, updated_at from saved_queries sq where ($1::uuid is null or sq.data_source_id = $1::uuid)")) {
      const [dataSourceId, tagFilter, callerUserId] = params;
      const rows = [...savedQueries.values()].filter((entry) => {
        if (dataSourceId && entry.data_source_id !== dataSourceId) return false;
        if (tagFilter && !(entry.tags || []).includes(tagFilter)) return false;
        if (entry.owner_id === callerUserId) return true;
        if (entry.visibility === "shared") return true;
        return false;
      });
      return { rowCount: rows.length, rows };
    }

    if (normalized.startsWith("select id, owner_id, name, description, data_source_id, sql, default_run_params, parameter_schema, tags, visibility, folder_id, created_at, updated_at from saved_queries where id = $1")) {
      const [id] = params;
      const row = savedQueries.get(id);
      return row ? { rowCount: 1, rows: [row] } : { rowCount: 0, rows: [] };
    }

    // Move endpoint: UPDATE WHERE id = $1 (single-row) — RETURNING includes
    // folder_id. The bulk WHERE folder_id = $1 form used by the delete path
    // has its own matcher below.
    if (normalized.startsWith("update saved_queries set folder_id = $2, updated_at = now() where id = $1")) {
      const [id, folderId] = params;
      const existing = savedQueries.get(id);
      if (!existing) return { rowCount: 0, rows: [] };
      const updated = { ...existing, folder_id: folderId, updated_at: new Date().toISOString() };
      savedQueries.set(id, updated);
      return { rowCount: 1, rows: [updated] };
    }

    if (normalized.startsWith("update saved_queries set folder_id = $2, updated_at = now() where folder_id = $1")) {
      const [oldFolderId, newFolderId] = params;
      const ids = [];
      for (const row of savedQueries.values()) {
        if (row.folder_id === oldFolderId) {
          row.folder_id = newFolderId || null;
          row.updated_at = new Date().toISOString();
          ids.push({ id: row.id });
        }
      }
      return { rowCount: ids.length, rows: ids };
    }

    if (normalized.startsWith("delete from saved_queries where id = $1 returning id")) {
      const [id] = params;
      if (!savedQueries.has(id)) return { rowCount: 0, rows: [] };
      savedQueries.delete(id);
      return { rowCount: 1, rows: [{ id }] };
    }

    // Version-service writes (savedQueryService records a v1 on create).
    if (normalized.startsWith("select coalesce(max(version_number), 0) as max_version from saved_query_versions where saved_query_id = $1")) {
      const [savedQueryId] = params;
      const maxVersion = [...savedQueryVersions.values()]
        .filter((row) => row.saved_query_id === savedQueryId)
        .reduce((max, row) => Math.max(max, row.version_number), 0);
      return { rowCount: 1, rows: [{ max_version: maxVersion }] };
    }
    if (normalized.startsWith("insert into saved_query_versions")) {
      const [savedQueryId, versionNumber, name, description, dataSourceId, sqlText, defaultRunParamsJson, parameterSchemaJson, tags, visibility, changeSummary, createdByUserId] = params;
      const now = new Date().toISOString();
      const row = {
        id: nextVersionId(),
        saved_query_id: savedQueryId,
        version_number: versionNumber,
        name,
        description,
        data_source_id: dataSourceId,
        sql: sqlText,
        default_run_params: JSON.parse(defaultRunParamsJson),
        parameter_schema: JSON.parse(parameterSchemaJson),
        tags: Array.isArray(tags) ? tags : [],
        visibility: visibility || "private",
        change_summary: changeSummary,
        created_by_user_id: createdByUserId,
        created_at: now
      };
      savedQueryVersions.set(row.id, row);
      return { rowCount: 1, rows: [row] };
    }

    // ---- Folder SQL ---------------------------------------------------------

    if (normalized.startsWith("select id, owner_id, parent_id, name, created_at, updated_at from saved_query_folders where id = $1")) {
      const [id] = params;
      const row = folders.get(id);
      return row ? { rowCount: 1, rows: [row] } : { rowCount: 0, rows: [] };
    }

    if (normalized.startsWith("insert into saved_query_folders")) {
      const [ownerId, parentId, name] = params;
      // Mirror the partial UNIQUE indexes for sibling-name collisions.
      const duplicate = [...folders.values()].find((entry) => (
        entry.owner_id === ownerId
        && (entry.parent_id || null) === (parentId || null)
        && entry.name.toLowerCase() === String(name).toLowerCase()
      ));
      if (duplicate) throw duplicateError();
      const now = new Date().toISOString();
      const row = {
        id: nextFolderId(),
        owner_id: ownerId,
        parent_id: parentId || null,
        name,
        created_at: now,
        updated_at: now
      };
      folders.set(row.id, row);
      return { rowCount: 1, rows: [row] };
    }

    if (normalized.startsWith("select id, owner_id, parent_id, name, created_at, updated_at from saved_query_folders where owner_id = $1")) {
      const [ownerId] = params;
      const rows = [...folders.values()]
        .filter((entry) => entry.owner_id === ownerId)
        .sort((a, b) => {
          const aRoot = a.parent_id == null ? 0 : 1;
          const bRoot = b.parent_id == null ? 0 : 1;
          if (aRoot !== bRoot) return aRoot - bRoot;
          return a.name.toLowerCase().localeCompare(b.name.toLowerCase());
        });
      return { rowCount: rows.length, rows };
    }

    // Ancestor / descendant walks issued by the folder service.
    if (normalized.startsWith("with recursive chain as")) {
      const [folderId] = params;
      const chain = [];
      let cursor = folders.get(folderId);
      let safety = 0;
      while (cursor && safety < 100) {
        chain.push({ id: cursor.id });
        if (!cursor.parent_id) break;
        cursor = folders.get(cursor.parent_id);
        safety += 1;
      }
      return { rowCount: chain.length, rows: chain };
    }

    if (normalized.startsWith("with recursive subtree as")) {
      const [ancestorId, candidateId] = params;
      const subtree = new Set();
      const queue = [ancestorId];
      while (queue.length) {
        const id = queue.shift();
        if (subtree.has(id)) continue;
        subtree.add(id);
        for (const folder of folders.values()) {
          if (folder.parent_id === id) queue.push(folder.id);
        }
      }
      if (subtree.has(candidateId)) {
        return { rowCount: 1, rows: [{ "?column?": 1 }] };
      }
      return { rowCount: 0, rows: [] };
    }

    if (normalized.startsWith("update saved_query_folders set name = $2")) {
      const [id, name, parentId] = params;
      const existing = folders.get(id);
      if (!existing) return { rowCount: 0, rows: [] };
      const duplicate = [...folders.values()].find((entry) => (
        entry.id !== id
        && entry.owner_id === existing.owner_id
        && (entry.parent_id || null) === (parentId || null)
        && entry.name.toLowerCase() === String(name).toLowerCase()
      ));
      if (duplicate) throw duplicateError();
      const updated = {
        ...existing,
        name,
        parent_id: parentId || null,
        updated_at: new Date().toISOString()
      };
      folders.set(id, updated);
      return { rowCount: 1, rows: [updated] };
    }

    if (normalized.startsWith("update saved_query_folders set parent_id = $2")) {
      const [oldParentId, newParentId] = params;
      const ids = [];
      for (const folder of folders.values()) {
        if (folder.parent_id === oldParentId) {
          folder.parent_id = newParentId || null;
          folder.updated_at = new Date().toISOString();
          ids.push({ id: folder.id });
        }
      }
      return { rowCount: ids.length, rows: ids };
    }

    if (normalized.startsWith("delete from saved_query_folders where id = $1")) {
      const [id] = params;
      if (!folders.has(id)) return { rowCount: 0, rows: [] };
      folders.delete(id);
      return { rowCount: 1, rows: [] };
    }

    if (normalized.startsWith("insert into auth_audit_log")) {
      return { rowCount: 1, rows: [] };
    }

    throw new Error(`Unexpected SQL in folders stub: ${normalized}`);
  };
}

before(async () => {
  originalQuery = appDb.query;
  originalWithTransaction = appDb.withTransaction;
  originalCreateDatabaseAdapter = dbAdapterFactory.createDatabaseAdapter;
  originalIsSupportedDbType = dbAdapterFactory.isSupportedDbType;
  savedQueries = new Map();
  savedQueryVersions = new Map();
  folders = new Map();
  savedQueryCounter = 0;
  folderCounter = 0;
  savedQueryVersionCounter = 0;
  authStub = createAuthTestStub();

  (dbAdapterFactory as { createDatabaseAdapter: typeof dbAdapterFactory.createDatabaseAdapter }).createDatabaseAdapter = (() => ({
    async validateSql() { return { ok: true, errors: [], refs: [] }; },
    async executeParameterizedReadOnly() {
      return { columns: [], rows: [], rowCount: 0, durationMs: 1 };
    },
    async close() {}
  })) as unknown as typeof dbAdapterFactory.createDatabaseAdapter;
  (dbAdapterFactory as { isSupportedDbType: typeof dbAdapterFactory.isSupportedDbType }).isSupportedDbType = (dbType: string) => dbType === "postgres" || dbType === "mssql";

  const sqlHandler = buildSqlHandler();
  appDb.query = sqlHandler as unknown as typeof appDb.query;
  // The folder delete path uses appDb.withTransaction; route the client.query
  // calls back through the same stub so the in-memory state stays consistent.
  appDb.withTransaction = (async (handler) => handler({ query: sqlHandler } as unknown as Parameters<typeof appDb.withTransaction>[0] extends (c: infer C) => unknown ? C : never)) as unknown as typeof appDb.withTransaction;

  delete require.cache[require.resolve("../src/server")];
  const { startServer } = require("../src/server");
  server = await startServer();
  baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});

beforeEach(() => {
  savedQueries.clear();
  savedQueryVersions.clear();
  folders.clear();
  savedQueryCounter = 0;
  folderCounter = 0;
  savedQueryVersionCounter = 0;
});

after(async () => {
  await new Promise<void>((resolve, reject) => {
    server.close((err) => (err ? reject(err) : resolve()));
  });
  appDb.query = originalQuery;
  appDb.withTransaction = originalWithTransaction;
  (dbAdapterFactory as { createDatabaseAdapter: typeof dbAdapterFactory.createDatabaseAdapter }).createDatabaseAdapter = originalCreateDatabaseAdapter;
  (dbAdapterFactory as { isSupportedDbType: typeof dbAdapterFactory.isSupportedDbType }).isSupportedDbType = originalIsSupportedDbType;
});

test("QUERY-008 create folder at root and list returns flat + tree shape", async () => {
  const created = await api("POST", "/v1/saved-query-folders", { name: "Finance" }, "alice");
  assert.equal(created.status, 201);
  assert.equal(created.payload.name, "Finance");
  assert.equal(created.payload.parent_id, null);
  assert.equal(created.payload.owner_id, userId("alice"));

  const child = await api("POST", "/v1/saved-query-folders", {
    name: "Q1",
    parent_id: created.payload.id
  }, "alice");
  assert.equal(child.status, 201);
  assert.equal(child.payload.parent_id, created.payload.id);

  const list = await api("GET", "/v1/saved-query-folders", undefined, "alice");
  assert.equal(list.status, 200);
  assert.equal(list.payload.items.length, 2);
  assert.equal(list.payload.tree.length, 1);
  assert.equal(list.payload.tree[0].id, created.payload.id);
  assert.equal(list.payload.tree[0].children.length, 1);
  assert.equal(list.payload.tree[0].children[0].id, child.payload.id);
});

test("QUERY-008 sibling-name collisions are rejected; different parents allow same name", async () => {
  const root = await api("POST", "/v1/saved-query-folders", { name: "Reports" }, "owner-c");
  const conflict = await api("POST", "/v1/saved-query-folders", { name: " reports " }, "owner-c");
  assert.equal(conflict.status, 409);

  const other = await api("POST", "/v1/saved-query-folders", { name: "Q1" }, "owner-c");
  // Same name "Q1" is fine under a *different* parent...
  const nestedA = await api("POST", "/v1/saved-query-folders", {
    name: "Q1",
    parent_id: root.payload.id
  }, "owner-c");
  assert.equal(nestedA.status, 201);
  // ...but a duplicate under the same parent fails.
  const nestedConflict = await api("POST", "/v1/saved-query-folders", {
    name: "q1",
    parent_id: root.payload.id
  }, "owner-c");
  assert.equal(nestedConflict.status, 409);
  // And the root-level "Q1" is unaffected by the nested-level "Q1".
  assert.equal(other.status, 201);
});

test("QUERY-008 parent_id must belong to caller; cross-owner moves are 403", async () => {
  const myFolder = await api("POST", "/v1/saved-query-folders", { name: "Mine" }, "owner-self");
  const theirFolder = await api("POST", "/v1/saved-query-folders", { name: "Theirs" }, "owner-other");

  const attempt = await api("POST", "/v1/saved-query-folders", {
    name: "Nested",
    parent_id: theirFolder.payload.id
  }, "owner-self");
  assert.equal(attempt.status, 403);

  // Same applies to PUT.
  const renamed = await api("PUT", `/v1/saved-query-folders/${myFolder.payload.id}`, {
    parent_id: theirFolder.payload.id
  }, "owner-self");
  assert.equal(renamed.status, 403);
});

test("QUERY-008 update can rename and move a folder", async () => {
  const a = await api("POST", "/v1/saved-query-folders", { name: "A" }, "rename-owner");
  const b = await api("POST", "/v1/saved-query-folders", { name: "B" }, "rename-owner");

  const renamed = await api("PUT", `/v1/saved-query-folders/${a.payload.id}`, {
    name: "Alpha",
    parent_id: b.payload.id
  }, "rename-owner");
  assert.equal(renamed.status, 200);
  assert.equal(renamed.payload.name, "Alpha");
  assert.equal(renamed.payload.parent_id, b.payload.id);
});

test("QUERY-008 moving a folder into its own descendant is rejected", async () => {
  const root = await api("POST", "/v1/saved-query-folders", { name: "Root" }, "cycle-owner");
  const child = await api("POST", "/v1/saved-query-folders", {
    name: "Child",
    parent_id: root.payload.id
  }, "cycle-owner");
  const grand = await api("POST", "/v1/saved-query-folders", {
    name: "Grand",
    parent_id: child.payload.id
  }, "cycle-owner");

  const cycle = await api("PUT", `/v1/saved-query-folders/${root.payload.id}`, {
    parent_id: grand.payload.id
  }, "cycle-owner");
  assert.equal(cycle.status, 400);
  assert.match(cycle.payload.message, /descendant/i);
});

test("QUERY-008 a folder cannot be its own parent", async () => {
  const folder = await api("POST", "/v1/saved-query-folders", { name: "Loop" }, "self-loop-owner");
  const attempt = await api("PUT", `/v1/saved-query-folders/${folder.payload.id}`, {
    parent_id: folder.payload.id
  }, "self-loop-owner");
  assert.equal(attempt.status, 400);
});

test("QUERY-008 delete reparents child folders and saved queries to the deleted folder's parent", async () => {
  const root = await api("POST", "/v1/saved-query-folders", { name: "Root" }, "del-owner");
  const middle = await api("POST", "/v1/saved-query-folders", {
    name: "Middle",
    parent_id: root.payload.id
  }, "del-owner");
  const leaf = await api("POST", "/v1/saved-query-folders", {
    name: "Leaf",
    parent_id: middle.payload.id
  }, "del-owner");

  // Park a saved query under "Middle" so we can confirm it gets reparented.
  const query = await api("POST", "/v1/saved-queries", {
    name: "Revenue",
    data_source_id: DATA_SOURCE_ID,
    sql: "SELECT 1"
  }, "del-owner");
  assert.equal(query.status, 201);
  const moved = await api("POST", `/v1/saved-queries/${query.payload.id}/move`, {
    folder_id: middle.payload.id
  }, "del-owner");
  assert.equal(moved.status, 200);
  assert.equal(moved.payload.folder_id, middle.payload.id);

  // Delete Middle — Leaf and the saved query should reparent to Root.
  const del = await api("DELETE", `/v1/saved-query-folders/${middle.payload.id}`, undefined, "del-owner");
  assert.equal(del.status, 200);
  assert.equal(del.payload.reassigned_to, root.payload.id);
  assert.deepEqual(del.payload.reassigned_folder_ids, [leaf.payload.id]);
  assert.deepEqual(del.payload.reassigned_saved_query_ids, [query.payload.id]);

  const listAfter = await api("GET", "/v1/saved-query-folders", undefined, "del-owner");
  const leafNow = listAfter.payload.items.find((row) => row.id === leaf.payload.id);
  assert.equal(leafNow.parent_id, root.payload.id);

  const queryAfter = await api("GET", `/v1/saved-queries/${query.payload.id}`, undefined, "del-owner");
  assert.equal(queryAfter.payload.folder_id, root.payload.id);
});

test("QUERY-008 deleting a root folder reparents children to root (NULL)", async () => {
  const root = await api("POST", "/v1/saved-query-folders", { name: "Root" }, "root-del-owner");
  const child = await api("POST", "/v1/saved-query-folders", {
    name: "Child",
    parent_id: root.payload.id
  }, "root-del-owner");

  const del = await api("DELETE", `/v1/saved-query-folders/${root.payload.id}`, undefined, "root-del-owner");
  assert.equal(del.status, 200);
  assert.equal(del.payload.reassigned_to, null);

  const listAfter = await api("GET", "/v1/saved-query-folders", undefined, "root-del-owner");
  const childNow = listAfter.payload.items.find((row) => row.id === child.payload.id);
  assert.equal(childNow.parent_id, null);
});

test("QUERY-008 only the folder owner can update or delete", async () => {
  const created = await api("POST", "/v1/saved-query-folders", { name: "Mine" }, "owner-x");
  const updated = await api("PUT", `/v1/saved-query-folders/${created.payload.id}`, {
    name: "Stolen"
  }, "owner-y");
  assert.equal(updated.status, 403);
  const deleted = await api("DELETE", `/v1/saved-query-folders/${created.payload.id}`, undefined, "owner-y");
  assert.equal(deleted.status, 403);
});

test("QUERY-008 move endpoint relocates the saved query and returns folder context", async () => {
  const folder = await api("POST", "/v1/saved-query-folders", { name: "Inbox" }, "move-owner");
  const query = await api("POST", "/v1/saved-queries", {
    name: "Move Me",
    data_source_id: DATA_SOURCE_ID,
    sql: "SELECT 1"
  }, "move-owner");
  assert.equal(query.payload.folder_id, null);

  const moved = await api("POST", `/v1/saved-queries/${query.payload.id}/move`, {
    folder_id: folder.payload.id
  }, "move-owner");
  assert.equal(moved.status, 200);
  assert.equal(moved.payload.folder_id, folder.payload.id);
  assert.equal(moved.payload.previous_folder_id, null);
  assert.equal(moved.payload.saved_query.id, query.payload.id);
  assert.equal(moved.payload.saved_query.folder_id, folder.payload.id);

  // Moving back to root accepts `folder_id: null`.
  const back = await api("POST", `/v1/saved-queries/${query.payload.id}/move`, {
    folder_id: null
  }, "move-owner");
  assert.equal(back.status, 200);
  assert.equal(back.payload.folder_id, null);
  assert.equal(back.payload.previous_folder_id, folder.payload.id);
});

test("QUERY-008 move endpoint rejects non-owners and cross-owner folders", async () => {
  const ownerFolder = await api("POST", "/v1/saved-query-folders", { name: "Mine" }, "move-owner-2");
  const query = await api("POST", "/v1/saved-queries", {
    name: "Move Me 2",
    data_source_id: DATA_SOURCE_ID,
    sql: "SELECT 1"
  }, "move-owner-2");

  // Non-owner can't move someone else's query.
  const stranger = await api("POST", `/v1/saved-queries/${query.payload.id}/move`, {
    folder_id: ownerFolder.payload.id
  }, "stranger-mover");
  assert.equal(stranger.status, 403);

  // Owner can't park their query in someone else's folder.
  const otherOwnersFolder = await api("POST", "/v1/saved-query-folders", { name: "Theirs" }, "another-owner");
  const cross = await api("POST", `/v1/saved-queries/${query.payload.id}/move`, {
    folder_id: otherOwnersFolder.payload.id
  }, "move-owner-2");
  assert.equal(cross.status, 403);
});

test("QUERY-008 move endpoint returns 404 for unknown folder", async () => {
  const query = await api("POST", "/v1/saved-queries", {
    name: "Missing Target",
    data_source_id: DATA_SOURCE_ID,
    sql: "SELECT 1"
  }, "missing-folder-owner");

  const missing = await api("POST", `/v1/saved-queries/${query.payload.id}/move`, {
    folder_id: "00000000-0000-4000-8000-ffff99999999"
  }, "missing-folder-owner");
  assert.equal(missing.status, 404);
});

test("QUERY-008 create validates name length and parent shape", async () => {
  const blank = await api("POST", "/v1/saved-query-folders", { name: "   " }, "validate-owner");
  assert.equal(blank.status, 400);

  const tooLong = await api("POST", "/v1/saved-query-folders", { name: "x".repeat(200) }, "validate-owner");
  assert.equal(tooLong.status, 400);

  const badParent = await api("POST", "/v1/saved-query-folders", {
    name: "ok",
    parent_id: "not-a-uuid"
  }, "validate-owner");
  assert.equal(badParent.status, 400);

  const missingParent = await api("POST", "/v1/saved-query-folders", {
    name: "ok",
    parent_id: "00000000-0000-4000-8000-ffff99999999"
  }, "validate-owner");
  assert.equal(missingParent.status, 404);
});

test("QUERY-008 viewer role cannot create folders", async () => {
  const created = await api("POST", "/v1/saved-query-folders", {
    name: "Viewer Folder"
  }, "viewer-folder", { role: "viewer" });
  assert.equal(created.status, 403);
});
