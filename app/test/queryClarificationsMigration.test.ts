import "./helpers/setupEnv";
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";

test("0029 creates durable query clarification state and a single pending constraint", () => {
  const migrationPath = path.resolve(__dirname, "../../db/migrations/0029_query_clarifications.sql");
  const sql = fs.readFileSync(migrationPath, "utf8");

  assert.match(sql, /CREATE TABLE IF NOT EXISTS query_clarifications/i);
  assert.match(sql, /status IN \('pending', 'resolved', 'cancelled', 'superseded'\)/i);
  assert.match(sql, /selected_option_id TEXT/i);
  assert.match(sql, /WHERE status = 'pending'/i);
  assert.match(sql, /REFERENCES query_sessions\(id\) ON DELETE CASCADE/i);
});
