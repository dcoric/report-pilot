const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

test("0027_saved_query_schedules migration creates schedule + run tables and seeds permission", () => {
  const migrationPath = path.resolve(__dirname, "../../db/migrations/0027_saved_query_schedules.sql");
  const sql = fs.readFileSync(migrationPath, "utf8");

  // Schedule table
  assert.match(sql, /CREATE TABLE IF NOT EXISTS saved_query_schedules/i);
  assert.match(sql, /saved_query_id UUID NOT NULL REFERENCES saved_queries\(id\) ON DELETE CASCADE/i);
  assert.match(sql, /cron_expression TEXT NOT NULL/i);
  assert.match(sql, /timezone TEXT NOT NULL/i);
  assert.match(sql, /recipients TEXT\[\] NOT NULL/i);
  assert.match(sql, /delivery_mode TEXT NOT NULL/i);
  assert.match(sql, /CHECK \(delivery_mode IN \('email', 'download_artifact'\)\)/i);
  assert.match(sql, /format TEXT NOT NULL/i);
  assert.match(sql, /CHECK \(format IN \('json', 'csv', 'tsv', 'xlsx', 'parquet'\)\)/i);
  assert.match(sql, /parameter_overrides JSONB NOT NULL DEFAULT '\{\}'::jsonb/i);
  assert.match(sql, /status TEXT NOT NULL DEFAULT 'active'/i);
  assert.match(sql, /CHECK \(status IN \('active', 'paused'\)\)/i);
  assert.match(sql, /next_run_at TIMESTAMPTZ/i);
  assert.match(sql, /last_run_at TIMESTAMPTZ/i);
  assert.match(sql, /last_status TEXT/i);

  // Indexes
  assert.match(sql, /CREATE INDEX IF NOT EXISTS idx_saved_query_schedules_query/i);
  assert.match(sql, /CREATE INDEX IF NOT EXISTS idx_saved_query_schedules_due/i);

  // Runs table
  assert.match(sql, /CREATE TABLE IF NOT EXISTS saved_query_schedule_runs/i);
  assert.match(sql, /schedule_id UUID NOT NULL REFERENCES saved_query_schedules\(id\) ON DELETE CASCADE/i);
  assert.match(sql, /scheduled_for TIMESTAMPTZ NOT NULL/i);
  assert.match(sql, /attempt INT NOT NULL DEFAULT 1/i);
  assert.match(sql, /file_name TEXT/i);
  assert.match(sql, /file_size_bytes BIGINT/i);
  assert.match(sql, /row_count INT/i);
  assert.match(sql, /error_message TEXT/i);

  // Permission seed
  assert.match(sql, /INSERT INTO permissions/i);
  assert.match(sql, /'saved_queries\.schedule'/i);
  assert.match(sql, /INSERT INTO role_permissions/i);
  assert.match(sql, /WHERE lower\(r\.name\) IN \('admin', 'analyst'\)/i);
});
