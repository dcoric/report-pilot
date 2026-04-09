CREATE TABLE IF NOT EXISTS saved_queries (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  owner_id TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT,
  data_source_id UUID NOT NULL REFERENCES data_sources(id) ON DELETE CASCADE,
  sql TEXT NOT NULL,
  default_run_params JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_saved_queries_data_source
  ON saved_queries(data_source_id);

CREATE INDEX IF NOT EXISTS idx_saved_queries_owner
  ON saved_queries(owner_id);

CREATE UNIQUE INDEX IF NOT EXISTS idx_saved_queries_owner_data_source_name
  ON saved_queries(owner_id, data_source_id, lower(name));
