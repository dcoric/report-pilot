-- AIQ-007: versioned, indexed retrieval for large RAG corpora.

CREATE TABLE IF NOT EXISTS rag_index_state (
  data_source_id UUID PRIMARY KEY REFERENCES data_sources(id) ON DELETE CASCADE,
  schema_version BIGINT NOT NULL DEFAULT 1 CHECK (schema_version > 0),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE rag_documents
  ADD COLUMN IF NOT EXISTS schema_version BIGINT NOT NULL DEFAULT 1;

ALTER TABLE rag_documents
  ADD COLUMN IF NOT EXISTS search_vector TSVECTOR
  GENERATED ALWAYS AS (to_tsvector('simple', content)) STORED;

INSERT INTO rag_index_state (data_source_id, schema_version)
SELECT DISTINCT data_source_id, COALESCE(MAX(schema_version), 1)
FROM rag_documents
GROUP BY data_source_id
ON CONFLICT (data_source_id) DO NOTHING;

CREATE INDEX IF NOT EXISTS idx_rag_documents_search
  ON rag_documents USING GIN (search_vector);

CREATE INDEX IF NOT EXISTS idx_rag_documents_version_type_created
  ON rag_documents (data_source_id, schema_version, doc_type, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_rag_embeddings_document_model
  ON rag_embeddings (rag_document_id, embedding_model);
