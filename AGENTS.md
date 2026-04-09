# AGENTS.md - Report Pilot

Report Pilot is a local-first NL-to-SQL reporting runtime. This file is canonical.

## Commands

- `npm run setup`
- `npm run dev`
- `npm test`
- `npm run migrate`
- `npm --prefix frontend run lint`

## Code Map

- `app/src/services`: orchestration, policy, SQL safety, provider routing, RAG workflows. Prefer business logic here.
- `app/src/adapters`: DB-specific introspection, quoting, validation, and execution.
- `app/src/adapters/llm`: provider-specific calls, health checks, and embeddings.
- `db/migrations`: metadata schema. Add new numbered migrations; never edit applied migrations.
- `docs/api/openapi.yaml`: update when API request or response shapes change.
- `frontend/src/lib/api/types.ts`: keep frontend API types aligned with backend shape changes.
- `.agents/skills/`: repo-local skills.

## Hard Rules

- Keep reporting SQL read-only. Do not allow writes, DDL, or bypasses around validation, safety checks, or budgets.
- Keep generated SQL grounded in introspected schema, semantic metadata, RAG notes, and validated examples.
- Preserve auditability and operability. Do not hide failures that should surface in logs, metrics, feedback, release gates, or benchmarks.
- Keep DB-specific behavior in DB adapters, provider-specific behavior in LLM adapters, and shared policy in services.
- Avoid putting business logic in route handlers or frontend components.

## High-Value Files

- `app/src/server.js`, `app/src/start.js`, `app/src/migrate.js`
- `app/src/services/llmSqlService.js`, `app/src/services/sqlGenerator.js`
- `app/src/services/sqlAstValidator.js`, `app/src/services/sqlSafety.js`, `app/src/services/queryBudget.js`
- `app/src/services/introspectionService.js`, `app/src/services/ddlImportService.js`
- `app/src/services/ragService.js`, `app/src/services/ragRetrieval.js`
- `app/src/services/providerConfigService.js`

## Change Coupling

- API shape changes: update route code, `docs/api/openapi.yaml`, `frontend/src/lib/api/types.ts`, and affected UI calls.
- Query generation or safety changes: review `llmSqlService.js`, `sqlGenerator.js`, `sqlAstValidator.js`, `sqlSafety.js`, and `queryBudget.js` together.
- Introspection or RAG changes: keep schema metadata and indexed documents aligned; preserve reindex triggers after schema or semantic changes.
- Persisted state changes: add a migration before wiring service logic.

## Verification

- Run the narrowest relevant checks.
- Common checks: `npm test`, `npm run migrate`, `npm --prefix frontend run lint`

## Notes

- Keep `.env.example` in sync with required config changes.
- Runtime behavior is defined by code and migrations, not planning docs.
