-- QUERY-007: scheduled report delivery for saved queries.
--
-- Two tables:
--   * `saved_query_schedules` — one row per schedule attached to a saved query.
--     Stores cron expression, IANA timezone, recipients, delivery_mode,
--     output format, per-schedule parameter overrides, the next dispatch time
--     (precomputed from the cron + tz at create/update), and a `status` flag
--     so an owner can pause a schedule without deleting it.
--   * `saved_query_schedule_runs` — append-only delivery history. Every
--     dispatch attempt writes one row with status pending/running/succeeded/failed,
--     error_message, recipients, file_name + size, attempt number, and
--     timestamps. Used by GET /schedules to surface last status + retry visibility.
--
-- Recurrence syntax: 5-field cron in the schedule's timezone (e.g. "0 9 * * 1-5").
-- The service parses it; we do not store next-run-after rules in the DB.
-- `next_run_at` is recomputed by the service when the schedule is created,
-- updated, paused/resumed, and after each successful dispatch.
--
-- Recipients are stored as TEXT[] (validated by the service). Delivery mode is
-- 'email' or 'download_artifact' — the latter just retains the file for manual
-- retrieval and skips the SMTP step.
--
-- `parameter_overrides` is a JSONB map that fully overrides the saved query's
-- `default_run_params` parameter values when this schedule fires. Missing keys
-- fall back to the saved query's defaults.

CREATE TABLE IF NOT EXISTS saved_query_schedules (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  saved_query_id UUID NOT NULL REFERENCES saved_queries(id) ON DELETE CASCADE,
  owner_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  name TEXT NOT NULL,
  cron_expression TEXT NOT NULL,
  timezone TEXT NOT NULL DEFAULT 'UTC',
  recipients TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  delivery_mode TEXT NOT NULL DEFAULT 'email'
    CHECK (delivery_mode IN ('email', 'download_artifact')),
  format TEXT NOT NULL DEFAULT 'csv'
    CHECK (format IN ('json', 'csv', 'tsv', 'xlsx', 'parquet')),
  parameter_overrides JSONB NOT NULL DEFAULT '{}'::jsonb,
  status TEXT NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'paused')),
  next_run_at TIMESTAMPTZ,
  last_run_at TIMESTAMPTZ,
  last_status TEXT
    CHECK (last_status IN ('succeeded', 'failed', 'running', 'pending')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_saved_query_schedules_query
  ON saved_query_schedules (saved_query_id);

-- Used by the dispatcher to pull due schedules cheaply.
CREATE INDEX IF NOT EXISTS idx_saved_query_schedules_due
  ON saved_query_schedules (next_run_at)
  WHERE status = 'active' AND next_run_at IS NOT NULL;

CREATE TABLE IF NOT EXISTS saved_query_schedule_runs (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  schedule_id UUID NOT NULL REFERENCES saved_query_schedules(id) ON DELETE CASCADE,
  saved_query_id UUID NOT NULL REFERENCES saved_queries(id) ON DELETE CASCADE,
  scheduled_for TIMESTAMPTZ NOT NULL,
  started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'running', 'succeeded', 'failed')),
  attempt INT NOT NULL DEFAULT 1,
  recipients TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  delivery_mode TEXT NOT NULL,
  format TEXT NOT NULL,
  file_name TEXT,
  file_size_bytes BIGINT,
  row_count INT,
  error_message TEXT
);

CREATE INDEX IF NOT EXISTS idx_saved_query_schedule_runs_schedule_completed_at
  ON saved_query_schedule_runs (schedule_id, completed_at DESC);

-- Permission seed: 'saved_queries.schedule' guards the CRUD endpoints. Owners
-- of a saved query can always manage their own schedules; admins and analysts
-- get the permission by default. Viewers do not — scheduled delivery is a
-- write-like action because it materialises results to email.
INSERT INTO permissions (name, description) VALUES
  ('saved_queries.schedule', 'Schedule saved query delivery to email or download artifacts')
ON CONFLICT DO NOTHING;

WITH schedule_perm AS (
  SELECT id FROM permissions WHERE name = 'saved_queries.schedule'
)
INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, schedule_perm.id
  FROM roles r, schedule_perm
 WHERE lower(r.name) IN ('admin', 'analyst')
ON CONFLICT DO NOTHING;
