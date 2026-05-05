ALTER TABLE saved_queries
  ADD COLUMN IF NOT EXISTS tags TEXT[] NOT NULL DEFAULT '{}';

CREATE INDEX IF NOT EXISTS idx_saved_queries_tags
  ON saved_queries USING GIN (tags);
