-- QUERY-005: revision history for saved queries.
--
-- Every create / edit / restore writes a row to `saved_query_versions`
-- containing a full snapshot of the saved-query fields plus an optional
-- `change_summary`. `version_number` is monotonic per saved_query_id
-- (the service computes the next number under the UNIQUE constraint).
--
-- `data_source_id` is stored as a plain UUID (no FK) so deleting or moving
-- a data source doesn't orphan the version row — the history is meant to
-- survive even if the live row is later deleted (CASCADE clears it then).
-- The owner-restore path applies the snapshot back to `saved_queries` and
-- records a new version row so the timeline stays linear.

CREATE TABLE IF NOT EXISTS saved_query_versions (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  saved_query_id UUID NOT NULL REFERENCES saved_queries(id) ON DELETE CASCADE,
  version_number INT NOT NULL,
  name TEXT NOT NULL,
  description TEXT,
  data_source_id UUID NOT NULL,
  sql TEXT NOT NULL,
  default_run_params JSONB NOT NULL DEFAULT '{}'::jsonb,
  parameter_schema JSONB NOT NULL DEFAULT '[]'::jsonb,
  tags TEXT[] NOT NULL DEFAULT ARRAY[]::text[],
  visibility TEXT NOT NULL DEFAULT 'private'
    CHECK (visibility IN ('private', 'shared')),
  change_summary TEXT,
  created_by_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (saved_query_id, version_number)
);

CREATE INDEX IF NOT EXISTS idx_saved_query_versions_query_created_at
  ON saved_query_versions (saved_query_id, created_at DESC);
