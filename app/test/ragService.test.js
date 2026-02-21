const test = require("node:test");
const assert = require("node:assert/strict");

process.env.DATABASE_URL = process.env.DATABASE_URL || "postgresql://test:test@localhost:5432/test";

const appDb = require("../src/lib/appDb");
const { __private } = require("../src/services/ragService");

test("buildRagDocuments includes active rag_notes as policy documents", async () => {
  const dataSourceId = "00000000-0000-4000-8000-000000000111";
  const noteId = "00000000-0000-4000-8000-000000000222";
  const originalQuery = appDb.query;
  let ragNotesQuerySeen = false;

  appDb.query = async (sql) => {
    const normalized = String(sql).replace(/\s+/g, " ").trim().toLowerCase();
    if (normalized.includes("from rag_notes")) {
      ragNotesQuerySeen = true;
      return {
        rowCount: 1,
        rows: [
          {
            id: noteId,
            title: "Reporting policy",
            content: "Always exclude test orders"
          }
        ]
      };
    }
    return { rowCount: 0, rows: [] };
  };

  try {
    const docs = await __private.buildRagDocuments(dataSourceId);
    const noteDoc = docs.find((doc) => doc.refId === noteId);

    assert.equal(ragNotesQuerySeen, true);
    assert.ok(noteDoc);
    assert.equal(noteDoc.docType, "policy");
    assert.deepEqual(noteDoc.metadata, {
      source: "rag_note",
      title: "Reporting policy"
    });
    assert.equal(noteDoc.content, "note Reporting policy\nAlways exclude test orders");
  } finally {
    appDb.query = originalQuery;
  }
});
