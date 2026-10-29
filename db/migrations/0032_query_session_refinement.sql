-- Conversational report refinement: a session can refine the validated SQL of a parent session.

ALTER TABLE query_sessions
  ADD COLUMN IF NOT EXISTS parent_session_id UUID REFERENCES query_sessions(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_query_sessions_parent_session_id
  ON query_sessions (parent_session_id)
  WHERE parent_session_id IS NOT NULL;
