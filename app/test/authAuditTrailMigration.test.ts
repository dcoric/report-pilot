// AUTH-008: the audit trail migration extends auth_audit_log with the columns
// the API filters on (outcome, IP, user agent, actor_email) and adds indexes
// that back the default `/v1/admin/audit-events` listing.

import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as path from "path";

test("0018_auth_audit_trail migration adds outcome/ip/user_agent/actor_email columns and supporting indexes", () => {
  const migrationPath = path.resolve(__dirname, "../../db/migrations/0018_auth_audit_trail.sql");
  const sql = fs.readFileSync(migrationPath, "utf8");

  assert.match(sql, /ALTER TABLE auth_audit_log/i);
  assert.match(sql, /ADD COLUMN IF NOT EXISTS outcome TEXT/i);
  assert.match(sql, /ADD COLUMN IF NOT EXISTS ip_address TEXT/i);
  assert.match(sql, /ADD COLUMN IF NOT EXISTS user_agent TEXT/i);
  assert.match(sql, /ADD COLUMN IF NOT EXISTS actor_email TEXT/i);

  assert.match(sql, /CREATE INDEX IF NOT EXISTS idx_auth_audit_log_created_at/i);
  assert.match(sql, /CREATE INDEX IF NOT EXISTS idx_auth_audit_log_actor_user/i);
  assert.match(sql, /CREATE INDEX IF NOT EXISTS idx_auth_audit_log_outcome/i);
});
