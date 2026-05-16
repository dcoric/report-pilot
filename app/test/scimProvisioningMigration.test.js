// AUTH-013: migration adds the scim_tokens table and the
// scim_group_mappings column. Pure shape assertion.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

test("0021_scim_provisioning creates scim_tokens and adds scim_group_mappings", () => {
  const migrationPath = path.resolve(
    __dirname,
    "../../db/migrations/0021_scim_provisioning.sql"
  );
  const sql = fs.readFileSync(migrationPath, "utf8");

  assert.match(sql, /CREATE TABLE IF NOT EXISTS scim_tokens/i);
  assert.match(sql, /provider_id UUID NOT NULL REFERENCES auth_providers\(id\) ON DELETE CASCADE/i);
  assert.match(sql, /token_hash TEXT NOT NULL/i);
  assert.match(sql, /CREATE UNIQUE INDEX IF NOT EXISTS idx_scim_tokens_token_hash/i);
  assert.match(sql, /CREATE INDEX IF NOT EXISTS idx_scim_tokens_provider_active/i);

  assert.match(sql, /ALTER TABLE auth_providers/i);
  assert.match(sql, /scim_group_mappings JSONB NOT NULL DEFAULT '\{\}'::jsonb/i);
});
