import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as path from "path";

test("0012_saved_query_parameters migration adds parameter_schema", () => {
  const migrationPath = path.resolve(__dirname, "../../db/migrations/0012_saved_query_parameters.sql");
  const sql = fs.readFileSync(migrationPath, "utf8");

  assert.match(sql, /ALTER TABLE saved_queries/i);
  assert.match(sql, /ADD COLUMN IF NOT EXISTS parameter_schema JSONB NOT NULL DEFAULT '\[\]'::jsonb/i);
});
