ALTER TABLE data_sources DROP CONSTRAINT IF EXISTS data_sources_db_type_check;

ALTER TABLE data_sources
  ADD CONSTRAINT data_sources_db_type_check
  CHECK (db_type IN ('postgres', 'mssql'));
