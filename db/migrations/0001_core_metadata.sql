-- Core metadata schema for Report Pilot (PostgreSQL MVP)
-- This migration defines internal control-plane tables, not customer analytics tables.

CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

CREATE TABLE IF NOT EXISTS data_sources (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  name TEXT NOT NULL,
  db_type TEXT NOT NULL CHECK (db_type IN ('postgres')),
  connection_ref TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS schema_objects (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  data_source_id UUID NOT NULL REFERENCES data_sources(id) ON DELETE CASCADE,
  object_type TEXT NOT NULL CHECK (object_type IN ('table', 'view', 'materialized_view')),
  schema_name TEXT NOT NULL,
  object_name TEXT NOT NULL,
  description TEXT,
  hash TEXT NOT NULL,
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (data_source_id, schema_name, object_name)
);

CREATE TABLE IF NOT EXISTS columns (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  schema_object_id UUID NOT NULL REFERENCES schema_objects(id) ON DELETE CASCADE,
  column_name TEXT NOT NULL,
  data_type TEXT NOT NULL,
  nullable BOOLEAN NOT NULL,
  is_pk BOOLEAN NOT NULL DEFAULT FALSE,
  ordinal_position INTEGER NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (schema_object_id, column_name)
);

CREATE TABLE IF NOT EXISTS relationships (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  from_object_id UUID NOT NULL REFERENCES schema_objects(id) ON DELETE CASCADE,
  from_column TEXT NOT NULL,
  to_object_id UUID NOT NULL REFERENCES schema_objects(id) ON DELETE CASCADE,
  to_column TEXT NOT NULL,
  relationship_type TEXT NOT NULL CHECK (relationship_type IN ('fk', 'inferred')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS indexes (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  schema_object_id UUID NOT NULL REFERENCES schema_objects(id) ON DELETE CASCADE,
  index_name TEXT NOT NULL,
  columns TEXT[] NOT NULL,
  is_unique BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (schema_object_id, index_name)
);

CREATE TABLE IF NOT EXISTS semantic_entities (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  data_source_id UUID NOT NULL REFERENCES data_sources(id) ON DELETE CASCADE,
  entity_type TEXT NOT NULL CHECK (entity_type IN ('table', 'column', 'metric', 'dimension', 'rule')),
  target_ref TEXT NOT NULL,
  business_name TEXT NOT NULL,
  description TEXT,
  owner TEXT,
  version INTEGER NOT NULL DEFAULT 1,
  active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS metric_definitions (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  semantic_entity_id UUID NOT NULL REFERENCES semantic_entities(id) ON DELETE CASCADE,
  sql_expression TEXT NOT NULL,
  grain TEXT,
  filters_json JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS join_policies (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  data_source_id UUID NOT NULL REFERENCES data_sources(id) ON DELETE CASCADE,
  left_ref TEXT NOT NULL,
  right_ref TEXT NOT NULL,
  join_type TEXT NOT NULL,
  on_clause TEXT NOT NULL,
  approved BOOLEAN NOT NULL DEFAULT TRUE,
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS synonyms (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  data_source_id UUID NOT NULL REFERENCES data_sources(id) ON DELETE CASCADE,
  term TEXT NOT NULL,
  maps_to_ref TEXT NOT NULL,
  weight DOUBLE PRECISION NOT NULL DEFAULT 1.0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS rag_documents (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  data_source_id UUID NOT NULL REFERENCES data_sources(id) ON DELETE CASCADE,
  doc_type TEXT NOT NULL CHECK (doc_type IN ('schema', 'semantic', 'example', 'policy')),
  ref_id TEXT,
  content TEXT NOT NULL,
  metadata_json JSONB,
  content_hash TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS rag_embeddings (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  rag_document_id UUID NOT NULL REFERENCES rag_documents(id) ON DELETE CASCADE,
  embedding_model TEXT NOT NULL,
  -- Vector storage choice intentionally deferred; initial placeholder for provider-agnostic storage.
  vector_json JSONB NOT NULL,
  chunk_idx INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS nl_sql_examples (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  data_source_id UUID NOT NULL REFERENCES data_sources(id) ON DELETE CASCADE,
  question TEXT NOT NULL,
  sql TEXT NOT NULL,
  quality_score DOUBLE PRECISION,
  source TEXT NOT NULL CHECK (source IN ('manual', 'feedback')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS query_sessions (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id TEXT NOT NULL,
  data_source_id UUID NOT NULL REFERENCES data_sources(id) ON DELETE CASCADE,
  question TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'created',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS query_attempts (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  session_id UUID NOT NULL REFERENCES query_sessions(id) ON DELETE CASCADE,
  llm_provider TEXT NOT NULL,
  model TEXT NOT NULL,
  prompt_version TEXT NOT NULL,
  generated_sql TEXT NOT NULL,
  validation_result_json JSONB NOT NULL,
  latency_ms INTEGER NOT NULL,
  token_usage_json JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS query_results_meta (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  attempt_id UUID NOT NULL REFERENCES query_attempts(id) ON DELETE CASCADE,
  row_count INTEGER NOT NULL,
  duration_ms INTEGER NOT NULL,
  bytes_scanned BIGINT,
  truncated BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS user_feedback (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  session_id UUID NOT NULL REFERENCES query_sessions(id) ON DELETE CASCADE,
  rating INTEGER NOT NULL CHECK (rating BETWEEN 1 AND 5),
  corrected_sql TEXT,
  comment TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_schema_objects_data_source ON schema_objects(data_source_id);
CREATE INDEX IF NOT EXISTS idx_columns_schema_object ON columns(schema_object_id);
CREATE INDEX IF NOT EXISTS idx_semantic_entities_data_source ON semantic_entities(data_source_id);
CREATE INDEX IF NOT EXISTS idx_rag_documents_data_source ON rag_documents(data_source_id);
CREATE INDEX IF NOT EXISTS idx_query_sessions_data_source ON query_sessions(data_source_id);
CREATE INDEX IF NOT EXISTS idx_query_attempts_session ON query_attempts(session_id);
