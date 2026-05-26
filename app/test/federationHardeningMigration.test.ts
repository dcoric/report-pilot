// AUTH-015: migration adds the OIDC used-state table and the
// require_email_verified column. Pure shape assertion.

import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as path from "path";

test("0020_oidc_state_replay_and_email_verified creates oidc_used_states and adds require_email_verified", () => {
  const migrationPath = path.resolve(
    __dirname,
    "../../db/migrations/0020_oidc_state_replay_and_email_verified.sql"
  );
  const sql = fs.readFileSync(migrationPath, "utf8");

  assert.match(sql, /CREATE TABLE IF NOT EXISTS oidc_used_states/i);
  assert.match(sql, /state_hash TEXT PRIMARY KEY/i);
  assert.match(sql, /provider_id UUID REFERENCES auth_providers\(id\) ON DELETE CASCADE/i);
  assert.match(sql, /expires_at TIMESTAMPTZ NOT NULL/i);
  assert.match(sql, /CREATE INDEX IF NOT EXISTS idx_oidc_used_states_expires_at/i);

  assert.match(sql, /ALTER TABLE auth_providers/i);
  assert.match(sql, /require_email_verified BOOLEAN NOT NULL DEFAULT TRUE/i);
});
