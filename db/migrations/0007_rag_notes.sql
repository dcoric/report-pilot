CREATE TABLE IF NOT EXISTS rag_notes (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  data_source_id UUID NOT NULL REFERENCES data_sources(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  content TEXT NOT NULL,
  active BOOLEAN NOT NULL DEFAULT TRUE,
  created_by TEXT,
  updated_by TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_rag_notes_data_source
  ON rag_notes(data_source_id);

CREATE INDEX IF NOT EXISTS idx_rag_notes_data_source_active
  ON rag_notes(data_source_id, active);
