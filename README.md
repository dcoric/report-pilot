# Report Pilot Local Runtime

This repository now includes a local Docker setup with:

- `app`: minimal Report Pilot service runtime (Node.js), auto-runs SQL migrations on startup.
- `db`: dedicated PostgreSQL instance for app metadata and app data.

## Prerequisites

- Docker
- Docker Compose (v2)

## Run

```bash
cd /Users/dcoric/Projects/report-pilot
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

RAG:

- `POST /v1/rag/reindex?data_source_id=...`
- RAG reindex also runs automatically after introspection, semantic changes, and saved feedback examples.
- `/v1/query/sessions/{id}/run` uses retrieved RAG chunks in prompt context and returns `citations.rag_documents`.
- Retrieval is hybrid: lexical token matching + embeddings + reranking.
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

- Dataset: `/Users/dcoric/Projects/report-pilot/docs/evals/dvdrental-mvp-benchmark.json` (60 reporting prompts)
- Runner: `/Users/dcoric/Projects/report-pilot/app/src/benchmark/runMvpBenchmark.js`

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

Note: on first initialization of `test-data`, the restore script shifts all `date`/`timestamp` fields by dynamic offsets so the latest rental and latest payment land around yesterday (relative to system time), then caps shifted values at current system date/time to avoid future-dated rows.

Report outputs:

- JSON and Markdown reports in `/Users/dcoric/Projects/report-pilot/docs/evals/reports`
- Benchmark summary is also persisted to the app DB via `POST /v1/observability/release-gates/report`
- Runner exits with code `2` when one or more MVP release gates fail.

Progress tracker:

- `/Users/dcoric/Projects/report-pilot/IMPLEMENTATION_PLAN.md`
