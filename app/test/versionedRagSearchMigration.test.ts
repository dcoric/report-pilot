import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as path from "path";

test("0028 adds versioned GIN-indexed RAG retrieval storage", () => {
  const migrationPath = path.resolve(__dirname, "../../db/migrations/0028_versioned_rag_search.sql");
  const sql = fs.readFileSync(migrationPath, "utf8");

  assert.match(sql, /CREATE TABLE IF NOT EXISTS rag_index_state/i);
  assert.match(sql, /schema_version BIGINT NOT NULL/i);
  assert.match(sql, /GENERATED ALWAYS AS \(to_tsvector\('simple', content\)\) STORED/i);
  assert.match(sql, /USING GIN \(search_vector\)/i);
  assert.match(sql, /data_source_id, schema_version, doc_type, created_at DESC/i);
});
