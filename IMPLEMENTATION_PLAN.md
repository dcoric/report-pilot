# AI-DB Implementation Plan

Use this checklist as the execution tracker. Mark items done as implementation progresses.

## Phase 0 - Foundation

- [x] Dockerized local runtime (`app` + dedicated `postgres`) with health checks
- [x] Boot-time SQL migrations for app metadata schema
- [x] Structured API server with versioned endpoints (`/v1/...`)

## Phase 1 - Core Reporting Path (Postgres-first)

- [x] Implement `DatabaseAdapter` contract and `PostgresAdapter`
- [x] Implement data source management APIs:
  - [x] `POST /v1/data-sources`
  - [x] `POST /v1/data-sources/{id}/introspect`
  - [x] `GET /v1/schema-objects?data_source_id=...`
- [x] Persist introspected schema metadata (`schema_objects`, `columns`, `relationships`, `indexes`)
- [x] Implement admin semantic mapping APIs:
  - [x] `POST /v1/semantic-entities`
  - [x] `POST /v1/metric-definitions`
  - [x] `POST /v1/join-policies`
- [x] Implement query session APIs:
  - [x] `POST /v1/query/sessions`
  - [x] `POST /v1/query/sessions/{id}/run`
  - [x] `POST /v1/query/sessions/{id}/feedback`

## Phase 2 - LLM Provider Layer

- [x] Add LLM provider config persistence
- [x] Implement provider APIs:
  - [x] `POST /v1/llm/providers`
  - [x] `POST /v1/llm/routing-rules`
  - [x] `GET /v1/health/providers`
- [x] Add adapter stubs for:
  - [x] OpenAI
  - [x] Gemini
  - [x] DeepSeek
- [x] Add provider routing policy (primary + fallback)

## Phase 3 - NL2SQL Quality and Safety

- [x] Replace temporary SQL generator with LLM-driven SQL generation + fallback routing
- [x] AST-based SQL validation with read-only policy enforcement
- [x] Add `EXPLAIN` budget checks before execution
- [x] Add query confidence + source citations in response
- [x] Capture and re-use user-corrected SQL as examples

## Phase 4 - RAG Layer

- [ ] Build chunking pipeline for schema/semantic/policy/example docs
- [ ] Build embedding + retrieval pipeline (hybrid retrieval)
- [ ] Add RAG reindex trigger flow after introspection/semantic changes
- [ ] Use retrieved context in NL2SQL generation

## Phase 5 - Evaluation and Hardening

- [ ] Build MVP benchmark dataset (50-100 reporting prompts)
- [ ] Add automated benchmark runner and scoring report
- [ ] Add observability (latency, query cost, provider failures)
- [ ] Meet MVP release gates from `TECH_SPEC.md`
