const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

test("0011_saved_queries migration creates table and indexes", () => {
  const migrationPath = path.resolve(__dirname, "../../db/migrations/0011_saved_queries.sql");
  const sql = fs.readFileSync(migrationPath, "utf8");

  assert.match(sql, /CREATE TABLE IF NOT EXISTS saved_queries/i);
  assert.match(sql, /owner_id TEXT NOT NULL/i);
  assert.match(sql, /name TEXT NOT NULL/i);
  assert.match(sql, /description TEXT/i);
  assert.match(sql, /data_source_id UUID NOT NULL REFERENCES data_sources\(id\) ON DELETE CASCADE/i);
  assert.match(sql, /sql TEXT NOT NULL/i);
  assert.match(sql, /default_run_params JSONB NOT NULL DEFAULT '\{\}'::jsonb/i);
  assert.match(sql, /created_at TIMESTAMPTZ NOT NULL DEFAULT NOW\(\)/i);
  assert.match(sql, /updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW\(\)/i);
  assert.match(sql, /CREATE INDEX IF NOT EXISTS idx_saved_queries_data_source/i);
  assert.match(sql, /CREATE INDEX IF NOT EXISTS idx_saved_queries_owner/i);
  assert.match(sql, /CREATE UNIQUE INDEX IF NOT EXISTS idx_saved_queries_owner_data_source_name/i);
  assert.match(sql, /ON saved_queries\(owner_id, data_source_id, lower\(name\)\)/i);
});
