# Report Pilot Technical Specification

## 1) Objective

Build a production-ready application that converts natural language (NL) questions into safe, performant SQL for reporting use cases.

Primary constraints:

- Read-only reporting queries.
- Multi-database adapter architecture (initial implementation: PostgreSQL).
- Multi-LLM provider architecture (initial providers: OpenAI, Gemini, DeepSeek).
- RAG grounded on database schema (DDL/metadata) plus admin-curated business semantics.

## 2) Scope

### In Scope (MVP)

- NL -> SQL generation for reporting.
- Schema metadata ingestion from PostgreSQL system catalogs.
- Admin semantic mapping UI/API for table/column/metric descriptions.
- RAG retrieval over schema + semantic mappings + examples.
- Safe SQL execution with strict guardrails.
- Query audit and feedback capture.
- Pluggable provider abstractions for DB and LLM.

### Out of Scope (MVP)

- Write queries (`INSERT`, `UPDATE`, `DELETE`, `MERGE`, DDL).
- Dashboard authoring.
- Fine-tuning models.
- Cross-database federated query execution.

## 3) Non-Functional Requirements

- Availability target: 99.9% (service level, excluding DB outages).
- P95 end-to-end latency target: < 8s for standard questions.
- Security: least-privilege, read-only DB credentials, encrypted secrets.
- Observability: structured logs, traces, token usage, query cost metrics.
- Extensibility: add DB/LLM providers without changing core business logic.

## 4) High-Level Architecture

```text
Client (Web/API)
  -> Query API
      -> NL2SQL Orchestrator
          -> Retriever (Vector + lexical)
          -> LLM Provider Adapter (OpenAI/Gemini/DeepSeek)
          -> SQL Validator + Policy Engine
          -> DB Adapter (Postgres first)
      -> Result Formatter
      -> Audit/Feedback Store

Admin UI/API
  -> Semantic Catalog Service
  -> Schema Ingestion Service
```

Core services/modules:

1. `schema-ingestion`: pull DDL/metadata, normalize to canonical model.
2. `semantic-catalog`: admin-authored definitions and rules.
3. `retrieval`: embedding + indexing + retrieval/reranking.
4. `nl2sql-orchestrator`: prompt construction, generation, validation, retries.
5. `execution-gateway`: read-only query execution with limits/timeouts.
6. `audit-feedback`: usage logs, ratings, corrected SQL.

## 5) Canonical Data Model

Use a canonical schema independent of DB engine.

### 5.1 Schema Metadata

- `data_sources`
  - `id`, `name`, `db_type`, `connection_ref`, `status`, `created_at`
- `schema_objects`
  - `id`, `data_source_id`, `object_type(table|view|materialized_view)`, `schema_name`, `object_name`, `description`, `last_seen_at`, `hash`
- `columns`
  - `id`, `schema_object_id`, `column_name`, `data_type`, `nullable`, `is_pk`, `ordinal_position`
- `relationships`
  - `id`, `from_object_id`, `from_column`, `to_object_id`, `to_column`, `relationship_type(fk|inferred)`
- `indexes`
  - `id`, `schema_object_id`, `index_name`, `columns`, `is_unique`

### 5.2 Semantic Layer

- `semantic_entities`
  - `id`, `data_source_id`, `entity_type(table|column|metric|dimension|rule)`, `target_ref`, `business_name`, `description`, `owner`, `version`, `active`
- `metric_definitions`
  - `id`, `semantic_entity_id`, `sql_expression`, `grain`, `filters_json`
- `join_policies`
  - `id`, `data_source_id`, `left_ref`, `right_ref`, `join_type`, `on_clause`, `approved`, `notes`
- `synonyms`
  - `id`, `data_source_id`, `term`, `maps_to_ref`, `weight`

### 5.3 RAG and Learning

- `rag_documents`
  - `id`, `data_source_id`, `doc_type(schema|semantic|example|policy)`, `ref_id`, `content`, `metadata_json`, `content_hash`
- `rag_embeddings`
  - `id`, `rag_document_id`, `embedding_model`, `vector`, `chunk_idx`
- `nl_sql_examples`
  - `id`, `data_source_id`, `question`, `sql`, `quality_score`, `source(manual|feedback)`

### 5.4 Runtime/Audit

- `query_sessions`
  - `id`, `user_id`, `data_source_id`, `question`, `status`, `created_at`
- `query_attempts`
  - `id`, `session_id`, `llm_provider`, `model`, `prompt_version`, `generated_sql`, `validation_result_json`, `latency_ms`, `token_usage_json`
- `query_results_meta`
  - `id`, `attempt_id`, `row_count`, `duration_ms`, `bytes_scanned`, `truncated`
- `user_feedback`
  - `id`, `session_id`, `rating`, `corrected_sql`, `comment`, `created_at`

## 6) Adapter Interfaces

## 6.1 Database Adapter Interface

```ts
interface DatabaseAdapter {
  type: "postgres" | string;
  testConnection(): Promise<void>;
  introspectSchema(opts?: IntrospectionOptions): Promise<CanonicalSchemaSnapshot>;
  validateSql(sql: string): Promise<ValidationResult>;
  explain(sql: string): Promise<ExplainPlan>;
  executeReadOnly(sql: string, opts: ExecutionOptions): Promise<QueryResult>;
  quoteIdentifier(id: string): string;
  dialect(): SqlDialect;
}
```

MVP implementation: `PostgresAdapter`.

Postgres introspection sources:

- `information_schema.tables`
- `information_schema.columns`
- `information_schema.table_constraints`
- `information_schema.key_column_usage`
- `pg_catalog.pg_indexes`
- optional: `pg_description` for comments

Future adapters:

- `MySqlAdapter`
- `SnowflakeAdapter`
- `BigQueryAdapter`

## 6.2 LLM Adapter Interface

```ts
interface LlmAdapter {
  provider: "openai" | "gemini" | "deepseek" | string;
  generate(input: LlmGenerateInput): Promise<LlmGenerateOutput>;
  generateStructured<T>(input: LlmStructuredInput<T>): Promise<T>;
  embed(input: EmbedInput): Promise<EmbedOutput>;
  healthCheck(): Promise<void>;
}
```

Provider-specific implementations:

- `OpenAiAdapter`
- `GeminiAdapter`
- `DeepSeekAdapter`

Routing policy:

- Configurable primary and fallback provider per workspace/data source.
- Retry on transient provider failure with exponential backoff.
- Hard timeout per provider call.

## 7) NL -> SQL Pipeline

1. Receive question + selected data source.
2. Retrieve context:
  - top-K schema chunks
  - top-K semantic mappings
  - top-K NL/SQL examples
3. Plan generation (structured output):
  - intent
  - candidate tables
  - required metrics/dimensions
  - filters/time range
4. SQL generation (dialect-aware) constrained by retrieved context.
5. SQL validation:
  - parser/AST read-only checks
  - allowlist schema/object checks
  - denylist function checks
  - mandatory `LIMIT` (configurable)
6. Optional `EXPLAIN` budget check.
7. Execute query (read-only role, timeout, row cap).
8. Return:
  - result set preview
  - generated SQL
  - confidence + cited context objects
9. Persist audit and optional user feedback.

## 8) RAG Design

Chunk types:

- `schema_object_chunk`: table/view + columns + relationships summary
- `semantic_chunk`: admin descriptions, business logic, metric definitions
- `policy_chunk`: join constraints, sensitive data rules
- `example_chunk`: validated NL -> SQL examples

Index strategy:

- Hybrid retrieval: vector similarity + keyword BM25.
- Rerank top N with cross-encoder or LLM reranker (phase 2).
- Filter by selected data source and active semantic version.

Embedding model:

- Start with provider-specific embedding where available.
- Keep embedding provider independent from generation provider.

Re-index triggers:

- schema ingestion change hash differs
- semantic mapping update
- approved example added/updated

## 9) Prompting and Contracts

Use structured output contracts to reduce hallucinations.

`PlanOutput`:

```json
{
  "intent": "aggregation|listing|comparison|trend",
  "tables": ["schema.table_a"],
  "dimensions": ["region"],
  "metrics": ["net_revenue"],
  "filters": [{"field":"order_date","op":">=","value":"2025-01-01"}],
  "time_grain": "month"
}
```

`SqlOutput`:

```json
{
  "sql": "SELECT ...",
  "rationale": "short explanation",
  "used_refs": ["schema.orders", "metric.net_revenue"]
}
```

Prompt rules:

- Use only provided schema/semantic context.
- Never invent tables/columns.
- Prefer approved metrics and join rules.
- Produce SQL in requested dialect only.
- Enforce explicit time bounds when query intent implies reporting period.

## 10) Security and Governance

- DB credentials stored in secret manager (not DB tables).
- Per-data-source read-only DB role.
- PII policy:
  - tag sensitive columns in semantic layer
  - deny or mask based on RBAC
- Tenant/workspace isolation on all entities.
- Full audit log of prompts, SQL, execution metadata.
- Optional prompt redaction for sensitive user inputs.

## 11) API Specification (MVP)

### Query APIs

- `POST /v1/query/sessions`
  - input: `{ data_source_id, question }`
  - output: `{ session_id, status }`

- `POST /v1/query/sessions/{id}/run`
  - input: `{ llm_provider?, model?, max_rows?, timeout_ms? }`
  - output: `{ attempt_id, sql, columns, rows, row_count, duration_ms, confidence }`

- `POST /v1/query/sessions/{id}/feedback`
  - input: `{ rating, corrected_sql?, comment? }`
  - output: `{ ok: true }`

### Admin APIs

- `POST /v1/data-sources`
- `POST /v1/data-sources/{id}/introspect`
- `GET /v1/schema-objects?data_source_id=...`
- `POST /v1/semantic-entities`
- `POST /v1/metric-definitions`
- `POST /v1/join-policies`
- `POST /v1/rag/reindex?data_source_id=...`

### Provider Config APIs

- `POST /v1/llm/providers`
- `POST /v1/llm/routing-rules`
- `GET /v1/health/providers`

## 12) Execution Policies (Defaults)

- `max_rows`: 1000
- `statement_timeout_ms`: 20000
- `generation_timeout_ms`: 15000
- `max_attempts_per_query`: 2
- `require_limit`: true
- `blocked_sql_keywords`: `INSERT`, `UPDATE`, `DELETE`, `ALTER`, `DROP`, `TRUNCATE`, `CREATE`, `GRANT`, `REVOKE`

## 13) Tech Stack (Recommended)

- Backend: TypeScript + Node.js (Fastify/NestJS).
- SQL parsing/AST:
  - PostgreSQL parser library or generic SQL parser with dialect support.
- DB access: `pg` for PostgreSQL adapter.
- Vector store:
  - PostgreSQL + pgvector (simple MVP path), or dedicated vector DB.
- Queue/scheduler:
  - lightweight job queue for ingestion/reindex.
- Frontend:
  - React admin + query console.

## 14) Testing Strategy

- Unit tests:
  - adapter contract tests (DB + LLM)
  - SQL validation policy tests
  - prompt contract parsing tests
- Integration tests:
  - Postgres introspection and execution
  - end-to-end NL -> SQL with mocked LLM responses
- Evaluation tests:
  - benchmark suite of real reporting questions
  - correctness score and safety violation rate thresholds

Release gates:

- 0 critical safety violations on benchmark.
- >= 85% result correctness on MVP question set.
- P95 latency target met in staging load tests.

## 15) Delivery Plan

### Phase 0 (1 week) - Foundations

- Set up project skeleton and canonical models.
- Implement provider interfaces and config.
- Basic auth and workspace boundaries.

### Phase 1 (2 weeks) - PostgreSQL + Single LLM happy path

- Postgres adapter: introspection + read-only execution.
- Semantic catalog CRUD.
- Basic RAG index and retrieval.
- NL -> SQL with one provider (pick OpenAI or Gemini first).
- Audit logging and feedback capture.

### Phase 2 (2 weeks) - Multi-LLM + safety hardening

- Add Gemini, OpenAI, DeepSeek adapters.
- Provider routing/fallback.
- AST validation + explain cost guardrails.
- Improved retrieval and prompt contracts.

### Phase 3 (2 weeks) - Productization

- Admin UX improvements and semantic versioning.
- Observability dashboards and alerting.
- Benchmark suite and regression automation.

## 16) Open Decisions

- Primary generation provider at launch (Gemini vs OpenAI) and fallback order.
- Embedding provider choice and cost/latency tradeoff.
- Vector store deployment model (pgvector vs managed vector DB).
- RBAC model depth for sensitive fields in MVP.

## 17) Immediate Next Build Artifacts

1. `docs/adr/001-canonical-adapter-interfaces.md`
2. `docs/adr/002-nl2sql-safety-policies.md`
3. `docs/api/openapi.yaml`
4. `docs/evals/mvp-benchmark-template.md`
5. `db/migrations/*` for core metadata tables

