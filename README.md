# Report Pilot Local Runtime

This repository now includes a local Docker setup with:

- `app`: minimal Report Pilot service runtime (Node.js), auto-runs SQL migrations on startup.
- `db`: dedicated PostgreSQL instance for app metadata and app data.

## Prerequisites

- Docker
- Docker Compose (v2)

For local development, use Node.js 20 or newer and run `npm run setup`. The backend uses the native TypeScript 7 compiler; `npm run types:openapi` uses an isolated TypeScript 5.9 toolchain until `openapi-typescript` supports the TypeScript 7 compiler API. In the migration benchmark, the combined backend and scripts typecheck improved from 2.43 seconds on TypeScript 5.9 to a median 0.39 seconds on TypeScript 7 (6.2x); results vary by machine and workload.

## Run

```bash
cd report-pilot
cp .env.example .env
docker compose up --build
```

Default ports:

- App: `http://localhost:8080`
- Postgres: `localhost:5433` (container internal port is still `5432`)

## Health Endpoints

- `GET /health`
- `GET /ready`

## API Docs

- Swagger UI: `http://localhost:8080/docs`
- OpenAPI spec: `http://localhost:8080/openapi.yaml`

Examples:

```bash
curl http://localhost:8080/health
curl http://localhost:8080/ready
```

## Stop

```bash
docker compose down
```

To also remove the DB volume:

```bash
docker compose down -v
```

## Notes

- On startup, the app applies SQL files from `db/migrations` to the local Postgres container.
- Migration state is tracked in the `schema_migrations` table.
- LLM provider keys can be supplied via `.env` (`OPENAI_API_KEY`, `GEMINI_API_KEY`, `DEEPSEEK_API_KEY`).
- `ALLOW_RULE_BASED_FALLBACK=true` keeps `/run` functional even when no provider key is configured.
- Enable LLM debug traces when needed:
  - `LLM_DEBUG_LOG=true` logs prompt input + provider response SQL to stdout as `llm_debug` events.
  - `LLM_DEBUG_MAX_CHARS=16000` caps logged prompt/SQL size per field.
- Pre-execution plan budget checks are enabled by default:
  - `EXPLAIN_BUDGET_ENABLED=true`
  - `EXPLAIN_MAX_TOTAL_COST=500000`
  - `EXPLAIN_MAX_PLAN_ROWS=1000000`

## Testing Data Sources

For local test DB setup (dvdrental Docker fixture, AdventureWorks on SQL Server Express, and connection strings), see:

- `test-data/README.md`

## Current API (Implemented)

Health:

- `GET /health`
- `GET /ready`

Data sources and schema:

- `GET /v1/data-sources`
- `POST /v1/data-sources`
- `POST /v1/data-sources/{id}/introspect`
- `GET /v1/schema-objects?data_source_id=...`

Semantic/admin:

- `POST /v1/semantic-entities`
- `POST /v1/metric-definitions`
- `POST /v1/join-policies`

Query sessions:

- `POST /v1/query/sessions`
- `POST /v1/query/sessions/{id}/run`
- `POST /v1/query/sessions/{id}/feedback`

`/v1/query/sessions/{id}/run` now returns:

- `provider` (selected provider + model)
- `confidence` (heuristic score)
- `citations` (schema/semantic/metric/join context references)

`/v1/query/sessions/{id}/feedback` now stores validated `corrected_sql` examples into `nl_sql_examples` (source=`feedback`) when valid.

LLM provider config:

- `POST /v1/llm/providers`
- `POST /v1/llm/routing-rules`
- `GET /v1/health/providers`

Observability:

- `GET /v1/observability/metrics?window_hours=24`
- `GET /v1/observability/release-gates`
- `GET /v1/observability/benchmark-command`
- `POST /v1/observability/release-gates/report`
- Each query run emits one `query_generation_diagnostics` JSON event correlated
  by `request_id` and `session_id`. It contains bounded table IDs/counts,
  expansion and fallback status, provider outcomes, stage latency, repair count,
  prompt-size estimates, and token totals. It never includes the question,
  prompt or SQL contents, query parameters, connection details, or raw provider
  errors.

RAG:

- `POST /v1/rag/reindex?data_source_id=...`
- RAG reindex also runs automatically after introspection, semantic changes, and saved feedback examples.
- `/v1/query/sessions/{id}/run` uses retrieved RAG chunks in prompt context and returns `citations.rag_documents`.
- Retrieval is hybrid: PostgreSQL GIN-indexed lexical candidate selection,
  embeddings, and deterministic reranking. Candidate work is bounded and
  filtered by datasource, current RAG schema version, and optional document
  type; recent current-version documents provide a deterministic local
  fallback when lexical search has too few matches.
- Table-card and schema-graph artifacts use a bounded in-memory cache keyed by
  datasource and current RAG schema version. Reindex entrypoints invalidate all
  artifact kinds immediately, and a completed reindex naturally moves reads to
  the new version key.
- Embeddings:
  - `RAG_EMBED_PROVIDER=auto|openai|gemini|local`
  - `RAG_EMBED_MODEL_OPENAI=text-embedding-3-small`
  - `RAG_EMBED_MODEL_GEMINI=text-embedding-004`
  - falls back to local hash embeddings when provider embeddings are unavailable.

Quick provider setup example:

```bash
curl -X POST http://localhost:8080/v1/llm/providers \
  -H 'Content-Type: application/json' \
  -d '{"provider":"openai","api_key_ref":"env:OPENAI_API_KEY","default_model":"gpt-4.1-mini","enabled":true}'
```

## MVP Benchmark (Phase 5)

Benchmark assets:

- Dataset: `docs/evals/dvdrental-mvp-benchmark.json` (60 reporting prompts)
- Large-schema fixture: `docs/evals/large-schema-linking-benchmark.json` (300 distractor tables plus multi-hop, wide-table, paraphrase, and ambiguity cases)
- Runner: `app/src/benchmark/runMvpBenchmark.ts`

Recommended flow with the dvdrental fixture:

```bash
# 1) Start dvdrental test DB (see test-data/README.md for connection strings)
docker compose -f test-data/docker-compose.yml up -d

# 2) Start app stack (metadata DB + API)
docker compose up --build -d

# 3) Run benchmark
BENCHMARK_DATA_SOURCE_NAME=dvdrental \
BENCHMARK_CONNECTION_REF=postgresql://postgres:postgres@host.docker.internal:5440/dvdrental \
BENCHMARK_ORACLE_CONN=postgresql://postgres:postgres@localhost:5440/dvdrental \
npm run benchmark:mvp
```

The provider-free schema-linking comparison can be run without databases or API keys:

```bash
npm run benchmark:large-schema
```

This command is also a required backend CI gate. It exits with code `2` when
table recall@15 falls below 95%, join-path accuracy falls below 100%, table
recall no longer improves over the legacy global prompt, or the hierarchical
prompt is no longer smaller than the legacy prompt. The JSON output includes
`gate_diagnostics` with the pipeline stage, metric, actual value, comparator,
and target for every gate; failed gates are also printed as concise stderr
messages. Runtime fallback, repair, and request-correlation diagnostics are
tracked separately from this provider-free schema-linking benchmark.

Note: on first initialization of `test-data`, the restore script shifts all `date`/`timestamp` fields by dynamic offsets so the latest rental and latest payment land around yesterday (relative to system time), then caps shifted values at current system date/time to avoid future-dated rows.

Report outputs:

- JSON and Markdown reports in `docs/evals/reports`
- Benchmark summary is also persisted to the app DB via `POST /v1/observability/release-gates/report`
- Runner exits with code `2` when one or more MVP release gates fail.
- Reports include table recall@15, join-path accuracy, repair rate, prompt size,
  schema-size/complexity stratification, and a legacy-global versus hierarchical comparison.
- The provider-backed MVP release gates also require rule-based fallback on at
  most 10% of successful runs and successful repair on at least 80% of runs
  where repair is attempted.
  A run with no repair attempts reports repair success as `null` and does not
  fail the repair gate.

Progress tracker:

- `IMPLEMENTATION_PLAN.md`
