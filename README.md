# AI-DB Local Runtime

This repository now includes a local Docker setup with:

- `app`: minimal AI-DB service runtime (Node.js), auto-runs SQL migrations on startup.
- `db`: dedicated PostgreSQL instance for app metadata and app data.

## Prerequisites

- Docker
- Docker Compose (v2)

## Run

```bash
cd /Users/dcoric/Projects/ai-db
cp .env.example .env
docker compose up --build
```

Default ports:

- App: `http://localhost:8080`
- Postgres: `localhost:5433` (container internal port is still `5432`)

## Health Endpoints

- `GET /health`
- `GET /ready`

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

## Current API (Implemented)

Health:

- `GET /health`
- `GET /ready`

Data sources and schema:

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

Progress tracker:

- `/Users/dcoric/Projects/ai-db/IMPLEMENTATION_PLAN.md`
