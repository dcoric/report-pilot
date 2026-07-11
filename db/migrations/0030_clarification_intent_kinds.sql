-- AIQ-008: support table and metric intent clarifications.

ALTER TABLE query_clarifications
  DROP CONSTRAINT IF EXISTS query_clarifications_kind_check;

ALTER TABLE query_clarifications
  ADD CONSTRAINT query_clarifications_kind_check
  CHECK (kind IN ('join_path', 'table', 'metric'));
