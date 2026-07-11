# AGENTS.md - Report Pilot

Report Pilot is a local-first NL-to-SQL reporting runtime. This file is canonical.

## Commands

- `npm run setup`
- `npm run dev` — concurrently runs `dev:fe` and `dev:be`; `dev:be` uses `tsx watch app/src/start.ts` so TypeScript edits trigger a restart
- `npm run build` — builds frontend (`npm run build:fe`) and backend (`npm run build:be`); backend output goes to `dist/` (compiled by `tsc`)
- `npm start` — runs the compiled backend via `node dist/src/start.js` (used by the Docker image)
- `npm test` — runs `node --test` with the `tsx` loader against `app/test/**/*.test.ts`
- `npm run test:e2e` — runs the Playwright Chromium smoke suite against a local Vite server
- `npm run typecheck`
- `npm run migrate`
- `npm run types:openapi` — regenerate `app/src/types/openapi.ts` from `docs/api/openapi.yaml`
- `npm --prefix frontend run lint`

## Type Discipline

- Backend source and tests are TypeScript-only. Do not add `.js` files under `app/src/**` or `app/test/**`.
- TypeScript 7 is the application compiler. The OpenAPI generator has an isolated TypeScript 5.9 toolchain because it still depends on the legacy compiler API.
- Production backend code, scripts, shared test helpers, and tests compile in strict mode.
- Prefer precise types or `unknown` over `any`; do not bypass type errors with `@ts-ignore`.

## Code Map

- `app/src/services`: orchestration, policy, SQL safety, provider routing, RAG workflows. Prefer business logic here.
- `app/src/adapters`: DB-specific introspection, quoting, validation, and execution.
- `app/src/adapters/llm`: provider-specific calls, health checks, and embeddings.
- `app/src/types`: shared TypeScript types. `openapi.ts` is generated from `docs/api/openapi.yaml` via `npm run types:openapi` (do not edit by hand); `domain.ts` holds hand-written shapes for DB rows and provider/config blobs; `index.ts` re-exports the common names. Add new generated bindings by updating the spec and regenerating; add new domain types to `domain.ts` and surface them through `index.ts`.
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

- `app/src/server.ts`, `app/src/start.ts`, `app/src/migrate.ts`
- `app/src/services/llmSqlService.ts`, `app/src/services/sqlGenerator.ts`
- `app/src/services/sqlAstValidator.ts`, `app/src/services/sqlSafety.ts`, `app/src/services/queryBudget.ts`
- `app/src/services/introspectionService.ts`, `app/src/services/ddlImportService.ts`
- `app/src/services/ragService.ts`, `app/src/services/ragRetrieval.ts`
- `app/src/services/providerConfigService.ts`

## Change Coupling

- API shape changes: update route code, `docs/api/openapi.yaml`, `frontend/src/lib/api/types.ts`, and affected UI calls.
- Query generation or safety changes: review `llmSqlService.ts`, `sqlGenerator.ts`, `sqlAstValidator.ts`, `sqlSafety.ts`, and `queryBudget.ts` together.
- Introspection or RAG changes: keep schema metadata and indexed documents aligned; preserve reindex triggers after schema or semantic changes.
- Persisted state changes: add a migration before wiring service logic.

## Verification

- Run the narrowest relevant checks.
- Common checks: `npm test`, `npm run migrate`, `npm --prefix frontend run lint`

## Notes

- Keep `.env.example` in sync with required config changes.
- Runtime behavior is defined by code and migrations, not planning docs.
