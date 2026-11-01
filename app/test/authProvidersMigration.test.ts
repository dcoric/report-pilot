import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as path from "path";

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

test("0031_auth_provider_types expands provider storage without enabling unimplemented types", () => {
  const migrationPath = path.resolve(__dirname, "../../db/migrations/0031_auth_provider_types.sql");
  const sql = fs.readFileSync(migrationPath, "utf8");

  assert.match(sql, /ADD COLUMN IF NOT EXISTS provider_config JSONB NOT NULL DEFAULT '\{\}'::jsonb/i);
  assert.match(sql, /CHECK \(jsonb_typeof\(provider_config\) = 'object'\)/i);
  assert.match(sql, /CHECK \(type = 'oidc' OR enabled = FALSE\)/i);
  assert.match(sql, /ALTER COLUMN issuer DROP NOT NULL/i);
  assert.match(sql, /ALTER COLUMN client_id DROP NOT NULL/i);
  assert.match(sql, /ALTER COLUMN scopes DROP NOT NULL/i);
  assert.match(sql, /ALTER COLUMN redirect_uri DROP NOT NULL/i);
  assert.match(sql, /ALTER COLUMN claims_mapping DROP NOT NULL/i);
  assert.match(sql, /CHECK \(type IN \('oidc', 'saml', 'ldap', 'ad', 'pd'\)\)/i);
});
