import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as path from "path";

test("0016_user_data_source_access creates the membership table and backfills non-admin users", () => {
  const migrationPath = path.resolve(__dirname, "../../db/migrations/0016_user_data_source_access.sql");
  const sql = fs.readFileSync(migrationPath, "utf8");

  assert.match(sql, /CREATE TABLE IF NOT EXISTS user_data_source_access/i);
  assert.match(sql, /user_id UUID NOT NULL REFERENCES users\(id\) ON DELETE CASCADE/i);
  assert.match(sql, /data_source_id UUID NOT NULL REFERENCES data_sources\(id\) ON DELETE CASCADE/i);
  assert.match(sql, /granted_by_user_id UUID REFERENCES users\(id\) ON DELETE SET NULL/i);
  assert.match(sql, /PRIMARY KEY \(user_id, data_source_id\)/i);
  assert.match(sql, /CREATE INDEX IF NOT EXISTS idx_user_data_source_access_data_source/i);

  // Backfill: every non-admin gets every existing source
  assert.match(sql, /INSERT INTO user_data_source_access \(user_id, data_source_id\)/i);
  assert.match(sql, /FROM users u\s+CROSS JOIN data_sources ds/i);
  assert.match(sql, /lower\(r\.name\) = 'admin'/i);
  assert.match(sql, /ON CONFLICT DO NOTHING/i);
});
