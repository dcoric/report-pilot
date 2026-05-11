const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

test("0014_auth_users_and_sessions migration creates users and sessions tables", () => {
  const migrationPath = path.resolve(__dirname, "../../db/migrations/0014_auth_users_and_sessions.sql");
  const sql = fs.readFileSync(migrationPath, "utf8");

  assert.match(sql, /CREATE TABLE IF NOT EXISTS users/i);
  assert.match(sql, /email TEXT NOT NULL/i);
  assert.match(sql, /password_hash TEXT/i);
  assert.match(sql, /display_name TEXT/i);
  assert.match(sql, /is_active BOOLEAN NOT NULL DEFAULT TRUE/i);
  assert.match(sql, /CREATE UNIQUE INDEX IF NOT EXISTS idx_users_email_lower/i);
  assert.match(sql, /ON users \(lower\(email\)\)/i);

  assert.match(sql, /CREATE TABLE IF NOT EXISTS user_sessions/i);
  assert.match(sql, /user_id UUID NOT NULL REFERENCES users\(id\) ON DELETE CASCADE/i);
  assert.match(sql, /token_hash TEXT NOT NULL/i);
  assert.match(sql, /expires_at TIMESTAMPTZ NOT NULL/i);
  assert.match(sql, /revoked_at TIMESTAMPTZ/i);
  assert.match(sql, /CREATE UNIQUE INDEX IF NOT EXISTS idx_user_sessions_token_hash/i);
  assert.match(sql, /CREATE INDEX IF NOT EXISTS idx_user_sessions_user_id/i);
  assert.match(sql, /CREATE INDEX IF NOT EXISTS idx_user_sessions_expires_at/i);
});
