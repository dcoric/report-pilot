// AUTH-006: migration shape — user_configs table + self-service permissions.

import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as path from "path";

test("0022_user_config_profiles creates user_configs and seeds self-service permissions", () => {
  const migrationPath = path.resolve(
    __dirname,
    "../../db/migrations/0022_user_config_profiles.sql"
  );
  const sql = fs.readFileSync(migrationPath, "utf8");

  assert.match(sql, /CREATE TABLE IF NOT EXISTS user_configs/i);
  assert.match(sql, /user_id UUID PRIMARY KEY REFERENCES users\(id\) ON DELETE CASCADE/i);
  assert.match(sql, /config JSONB NOT NULL DEFAULT '\{\}'::jsonb/i);

  assert.match(sql, /'users\.read_self'/);
  assert.match(sql, /'users\.write_self'/);
  // Granted to system roles
  assert.match(sql, /WHERE lower\(name\) IN \('admin', 'analyst', 'viewer'\)/i);
});
