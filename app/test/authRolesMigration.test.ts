import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as path from "path";

test("0015_auth_roles_and_permissions migration creates role tables, audit log, and seeds system roles", () => {
  const migrationPath = path.resolve(__dirname, "../../db/migrations/0015_auth_roles_and_permissions.sql");
  const sql = fs.readFileSync(migrationPath, "utf8");

  assert.match(sql, /CREATE TABLE IF NOT EXISTS roles/i);
  assert.match(sql, /is_system BOOLEAN NOT NULL DEFAULT FALSE/i);
  assert.match(sql, /CREATE UNIQUE INDEX IF NOT EXISTS idx_roles_name_lower/i);

  assert.match(sql, /CREATE TABLE IF NOT EXISTS permissions/i);
  assert.match(sql, /CREATE UNIQUE INDEX IF NOT EXISTS idx_permissions_name/i);

  assert.match(sql, /CREATE TABLE IF NOT EXISTS role_permissions/i);
  assert.match(sql, /PRIMARY KEY \(role_id, permission_id\)/i);

  assert.match(sql, /CREATE TABLE IF NOT EXISTS user_roles/i);
  assert.match(sql, /assigned_by_user_id UUID REFERENCES users\(id\) ON DELETE SET NULL/i);
  assert.match(sql, /PRIMARY KEY \(user_id, role_id\)/i);

  assert.match(sql, /CREATE TABLE IF NOT EXISTS auth_audit_log/i);
  assert.match(sql, /actor_user_id UUID REFERENCES users\(id\) ON DELETE SET NULL/i);
  assert.match(sql, /target_user_id UUID REFERENCES users\(id\) ON DELETE SET NULL/i);
  assert.match(sql, /action TEXT NOT NULL/i);
  assert.match(sql, /details JSONB NOT NULL DEFAULT '\{\}'::jsonb/i);
  assert.match(sql, /CREATE INDEX IF NOT EXISTS idx_auth_audit_log_target_user/i);
  assert.match(sql, /CREATE INDEX IF NOT EXISTS idx_auth_audit_log_action/i);

  // Seed system roles
  assert.match(sql, /INSERT INTO roles \(name, description, is_system\)/i);
  assert.match(sql, /\('admin',/i);
  assert.match(sql, /\('analyst',/i);
  assert.match(sql, /\('viewer',/i);

  // Permission seeds we will rely on in AUTH-003
  for (const perm of [
    "users.read",
    "users.write",
    "roles.assign",
    "data_sources.read",
    "data_sources.write",
    "query.run",
    "saved_queries.write"
  ]) {
    assert.match(sql, new RegExp(`'${perm.replace(/\./g, "\\.")}'`, "i"));
  }
});
