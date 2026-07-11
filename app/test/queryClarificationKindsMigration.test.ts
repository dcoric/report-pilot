import "./helpers/setupEnv";
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";

test("0030 enables table and metric clarification kinds", () => {
  const migrationPath = path.resolve(__dirname, "../../db/migrations/0030_clarification_intent_kinds.sql");
  const sql = fs.readFileSync(migrationPath, "utf8");

  assert.match(sql, /DROP CONSTRAINT IF EXISTS query_clarifications_kind_check/i);
  assert.match(sql, /kind IN \('join_path', 'table', 'metric'\)/i);
});
