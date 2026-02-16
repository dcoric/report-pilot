ALTER TABLE export_deliveries
  DROP CONSTRAINT IF EXISTS export_deliveries_format_check;

ALTER TABLE export_deliveries
  ADD CONSTRAINT export_deliveries_format_check
  CHECK (format IN ('json', 'csv', 'xlsx', 'tsv', 'parquet'));
