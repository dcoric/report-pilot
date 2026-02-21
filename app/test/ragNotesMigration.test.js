const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

test("0007_rag_notes migration creates table and indexes", () => {
  const migrationPath = path.resolve(__dirname, "../../db/migrations/0007_rag_notes.sql");
  const sql = fs.readFileSync(migrationPath, "utf8");

  assert.match(sql, /CREATE TABLE IF NOT EXISTS rag_notes/i);
  assert.match(sql, /data_source_id UUID NOT NULL REFERENCES data_sources\(id\) ON DELETE CASCADE/i);
  assert.match(sql, /title TEXT NOT NULL/i);
  assert.match(sql, /content TEXT NOT NULL/i);
  assert.match(sql, /active BOOLEAN NOT NULL DEFAULT TRUE/i);
  assert.match(sql, /created_at TIMESTAMPTZ NOT NULL DEFAULT NOW\(\)/i);
  assert.match(sql, /updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW\(\)/i);
  assert.match(sql, /CREATE INDEX IF NOT EXISTS idx_rag_notes_data_source/i);
  assert.match(sql, /CREATE INDEX IF NOT EXISTS idx_rag_notes_data_source_active/i);
});
