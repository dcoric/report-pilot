const { test, before, after, beforeEach } = require("node:test");
const assert = require("node:assert/strict");

process.env.DATABASE_URL = process.env.DATABASE_URL || "postgresql://test:test@localhost:5432/test";
process.env.PORT = "0";

const appDb = require("../src/lib/appDb");
const ragService = require("../src/services/ragService");

const DATA_SOURCE_ID = "00000000-0000-4000-8000-000000000111";
const OTHER_SOURCE_ID = "00000000-0000-4000-8000-000000000333";

let server;
let baseUrl;
let notes;
let reindexCalls;
let noteCounter;
let originalQuery;
let originalReindex;
let originalSetImmediate;

function normalizeSql(sql) {
  return String(sql).replace(/\s+/g, " ").trim().toLowerCase();
}

function nextNoteId() {
  noteCounter += 1;
  return `00000000-0000-4000-8000-${String(noteCounter).padStart(12, "0")}`;
}

async function api(method, path, body) {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      "x-user-id": "test-user"
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
  originalReindex = ragService.reindexRagDocuments;
  originalSetImmediate = global.setImmediate;

  notes = new Map();
  reindexCalls = [];
  noteCounter = 0;

  appDb.query = async (sql, params = []) => {
    const normalized = normalizeSql(sql);

    if (normalized === "select id from data_sources where id = $1") {
      const id = params[0];
      if (id === DATA_SOURCE_ID || id === OTHER_SOURCE_ID) {
        return { rowCount: 1, rows: [{ id }] };
      }
      return { rowCount: 0, rows: [] };
    }

    if (normalized.startsWith("select id, data_source_id, title, content, active, created_at, updated_at from rag_notes")) {
      const dataSourceId = params[0];
      const rows = [...notes.values()]
        .filter((note) => note.data_source_id === dataSourceId)
        .sort((a, b) => new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime());
      return { rowCount: rows.length, rows };
    }

    if (normalized.startsWith("insert into rag_notes")) {
      const now = new Date().toISOString();
      const [dataSourceId, title, content, active] = params;
      const id = nextNoteId();
      const note = {
        id,
        data_source_id: dataSourceId,
        title,
        content,
        active: Boolean(active),
        created_at: now,
        updated_at: now
      };
      notes.set(id, note);
      return { rowCount: 1, rows: [note] };
    }

    if (normalized.startsWith("update rag_notes")) {
      const [id, dataSourceId, title, content, active] = params;
      const existing = notes.get(id);
      if (!existing) {
        return { rowCount: 0, rows: [] };
      }
      const updated = {
        ...existing,
        data_source_id: dataSourceId,
        title,
        content,
        active: active === null ? existing.active : active,
        updated_at: new Date().toISOString()
      };
      notes.set(id, updated);
      return { rowCount: 1, rows: [updated] };
    }

    if (normalized.startsWith("delete from rag_notes")) {
      const [id] = params;
      const existing = notes.get(id);
      if (!existing) {
        return { rowCount: 0, rows: [] };
      }
      notes.delete(id);
      return {
        rowCount: 1,
        rows: [
          {
            id: existing.id,
            data_source_id: existing.data_source_id
          }
        ]
      };
    }

    throw new Error(`Unexpected SQL in test stub: ${normalized}`);
  };

  ragService.reindexRagDocuments = async (dataSourceId) => {
    reindexCalls.push(dataSourceId);
    return {
      data_source_id: dataSourceId,
      documents_indexed: 0,
      embedding_model: "test"
    };
  };

  global.setImmediate = (fn, ...args) => {
    fn(...args);
    return 0;
  };

  delete require.cache[require.resolve("../src/server")];
  const { startServer } = require("../src/server");
  server = await startServer();
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

beforeEach(() => {
  notes.clear();
  reindexCalls.length = 0;
  noteCounter = 0;
});

after(async () => {
  await new Promise((resolve, reject) => {
    server.close((err) => (err ? reject(err) : resolve()));
  });

  appDb.query = originalQuery;
  ragService.reindexRagDocuments = originalReindex;
  global.setImmediate = originalSetImmediate;
});

test("RAG notes create/update/list/delete happy path", async () => {
  const create = await api("POST", "/v1/rag/notes", {
    data_source_id: DATA_SOURCE_ID,
    title: "  Revenue policy  ",
    content: "  Exclude test transactions.  "
  });

  assert.equal(create.status, 200);
  assert.equal(create.payload.title, "Revenue policy");
  assert.equal(create.payload.content, "Exclude test transactions.");
  assert.deepEqual(reindexCalls, [DATA_SOURCE_ID]);

  const noteId = create.payload.id;

  const list = await api("GET", `/v1/rag/notes?data_source_id=${DATA_SOURCE_ID}`);
  assert.equal(list.status, 200);
  assert.equal(list.payload.items.length, 1);
  assert.equal(list.payload.items[0].id, noteId);

  const update = await api("POST", "/v1/rag/notes", {
    id: noteId,
    data_source_id: DATA_SOURCE_ID,
    title: "Updated policy",
    content: "Use net revenue only."
  });
  assert.equal(update.status, 200);
  assert.equal(update.payload.title, "Updated policy");
  assert.equal(reindexCalls.length, 2);
  assert.equal(reindexCalls[1], DATA_SOURCE_ID);

  const del = await api("DELETE", `/v1/rag/notes/${noteId}`);
  assert.equal(del.status, 200);
  assert.deepEqual(del.payload, { ok: true, id: noteId });
  assert.equal(reindexCalls.length, 3);
  assert.equal(reindexCalls[2], DATA_SOURCE_ID);

  const listAfterDelete = await api("GET", `/v1/rag/notes?data_source_id=${DATA_SOURCE_ID}`);
  assert.equal(listAfterDelete.status, 200);
  assert.equal(listAfterDelete.payload.items.length, 0);
});

test("RAG notes validation returns 400", async () => {
  const noSource = await api("GET", "/v1/rag/notes");
  assert.equal(noSource.status, 400);

  const invalidSource = await api("GET", "/v1/rag/notes?data_source_id=not-a-uuid");
  assert.equal(invalidSource.status, 400);

  const missingFields = await api("POST", "/v1/rag/notes", {
    data_source_id: DATA_SOURCE_ID,
    title: "   ",
    content: "  "
  });
  assert.equal(missingFields.status, 400);

  const titleTooLong = await api("POST", "/v1/rag/notes", {
    data_source_id: DATA_SOURCE_ID,
    title: "t".repeat(201),
    content: "valid content"
  });
  assert.equal(titleTooLong.status, 400);

  const contentTooLong = await api("POST", "/v1/rag/notes", {
    data_source_id: DATA_SOURCE_ID,
    title: "Valid title",
    content: "c".repeat(20001)
  });
  assert.equal(contentTooLong.status, 400);

  const invalidDeleteId = await api("DELETE", "/v1/rag/notes/not-a-uuid");
  assert.equal(invalidDeleteId.status, 400);

  assert.equal(reindexCalls.length, 0);
});

test("RAG notes not found paths return 404", async () => {
  const missingSource = await api("POST", "/v1/rag/notes", {
    data_source_id: "00000000-0000-4000-8000-000000009999",
    title: "Policy",
    content: "Valid content"
  });
  assert.equal(missingSource.status, 404);

  const updateMissingNote = await api("POST", "/v1/rag/notes", {
    id: "00000000-0000-4000-8000-000000009998",
    data_source_id: DATA_SOURCE_ID,
    title: "Policy",
    content: "Valid content"
  });
  assert.equal(updateMissingNote.status, 404);

  const deleteMissingNote = await api("DELETE", "/v1/rag/notes/00000000-0000-4000-8000-000000009997");
  assert.equal(deleteMissingNote.status, 404);

  assert.equal(reindexCalls.length, 0);
});
