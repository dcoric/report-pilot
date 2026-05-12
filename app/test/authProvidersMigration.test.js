const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

test("0017_auth_providers creates the auth_providers table", () => {
  const migrationPath = path.resolve(__dirname, "../../db/migrations/0017_auth_providers.sql");
  const sql = fs.readFileSync(migrationPath, "utf8");

  assert.match(sql, /CREATE TABLE IF NOT EXISTS auth_providers/i);
  assert.match(sql, /type TEXT NOT NULL CHECK \(type IN \('oidc'\)\)/i);
  assert.match(sql, /name TEXT NOT NULL/i);
  assert.match(sql, /issuer TEXT NOT NULL/i);
  assert.match(sql, /client_id TEXT NOT NULL/i);
  assert.match(sql, /client_secret TEXT/i);
  assert.match(sql, /scopes TEXT\[\] NOT NULL DEFAULT ARRAY\['openid', 'email', 'profile'\]::text\[\]/i);
  assert.match(sql, /redirect_uri TEXT NOT NULL/i);
  assert.match(sql, /claims_mapping JSONB NOT NULL DEFAULT '\{\}'::jsonb/i);
  assert.match(sql, /enabled BOOLEAN NOT NULL DEFAULT TRUE/i);

  assert.match(sql, /CREATE UNIQUE INDEX IF NOT EXISTS idx_auth_providers_name_lower/i);
  assert.match(sql, /CREATE INDEX IF NOT EXISTS idx_auth_providers_enabled/i);
});
