// AUTH-012: migration adds the linked_identities table and the per-provider
// JIT / linking columns. Pure shape assertion against the SQL text.

import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as path from "path";

test("0019_linked_identities_and_jit_rules creates linked_identities and adds JIT columns", () => {
  const migrationPath = path.resolve(
    __dirname,
    "../../db/migrations/0019_linked_identities_and_jit_rules.sql"
  );
  const sql = fs.readFileSync(migrationPath, "utf8");

  assert.match(sql, /CREATE TABLE IF NOT EXISTS linked_identities/i);
  assert.match(sql, /user_id UUID NOT NULL REFERENCES users\(id\) ON DELETE CASCADE/i);
  assert.match(sql, /provider_id UUID NOT NULL REFERENCES auth_providers\(id\) ON DELETE CASCADE/i);
  assert.match(sql, /subject TEXT NOT NULL/i);
  assert.match(sql, /CREATE UNIQUE INDEX IF NOT EXISTS idx_linked_identities_provider_subject/i);
  assert.match(sql, /CREATE INDEX IF NOT EXISTS idx_linked_identities_user/i);

  assert.match(sql, /ALTER TABLE auth_providers/i);
  assert.match(sql, /auto_link_by_email BOOLEAN NOT NULL DEFAULT TRUE/i);
  assert.match(sql, /jit_enabled BOOLEAN NOT NULL DEFAULT FALSE/i);
  assert.match(sql, /jit_default_role TEXT NOT NULL DEFAULT 'viewer'/i);
  assert.match(sql, /jit_allowed_domains TEXT\[\] NOT NULL DEFAULT ARRAY\[\]::text\[\]/i);
});
