// AUTH-007: migration shape — prompt_presets table + indexes.

import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as path from "path";

test("0023_prompt_presets creates prompt_presets with owner FK and visibility check", () => {
  const migrationPath = path.resolve(
    __dirname,
    "../../db/migrations/0023_prompt_presets.sql"
  );
  const sql = fs.readFileSync(migrationPath, "utf8");

  assert.match(sql, /CREATE TABLE IF NOT EXISTS prompt_presets/i);
  assert.match(sql, /owner_user_id UUID NOT NULL REFERENCES users\(id\) ON DELETE CASCADE/i);
  assert.match(sql, /data_source_id UUID REFERENCES data_sources\(id\) ON DELETE SET NULL/i);
  assert.match(sql, /visibility TEXT NOT NULL DEFAULT 'private'/i);
  assert.match(sql, /CHECK \(visibility IN \('private', 'shared'\)\)/i);
  assert.match(sql, /CREATE INDEX IF NOT EXISTS idx_prompt_presets_owner/i);
  assert.match(sql, /CREATE INDEX IF NOT EXISTS idx_prompt_presets_shared/i);
  assert.match(sql, /WHERE visibility = 'shared'/i);
});
