-- AIQ-008: durable, auditable clarification state for ambiguous query intent.

CREATE TABLE IF NOT EXISTS query_clarifications (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  session_id UUID NOT NULL REFERENCES query_sessions(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('join_path')),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'resolved', 'cancelled', 'superseded')),
  options_json JSONB NOT NULL,
  selected_option_id TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  resolved_at TIMESTAMPTZ,
  CHECK (
    (status = 'resolved' AND selected_option_id IS NOT NULL AND resolved_at IS NOT NULL)
    OR status <> 'resolved'
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_query_clarifications_one_pending
  ON query_clarifications (session_id)
  WHERE status = 'pending';

CREATE INDEX IF NOT EXISTS idx_query_clarifications_session_created
  ON query_clarifications (session_id, created_at DESC);
