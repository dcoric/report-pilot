ALTER TABLE schema_objects
  ADD COLUMN IF NOT EXISTS is_ignored BOOLEAN NOT NULL DEFAULT FALSE;

CREATE INDEX IF NOT EXISTS idx_schema_objects_data_source_is_ignored
  ON schema_objects(data_source_id, is_ignored);
