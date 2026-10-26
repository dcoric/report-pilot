# Development and evaluation

## Development commands

| Command | Purpose |
| --- | --- |
| `npm run setup` | Install backend, frontend, and isolated OpenAPI generator dependencies. |
| `npm run dev` | Start Vite and the API watcher. The API needs `DATABASE_URL` in its environment. |
| `npm run typecheck` | Check backend, scripts, and test types. |
| `npm test` | Run backend tests. |
| `npm --prefix frontend run lint` | Lint the frontend. |
| `npm run build` | Build frontend and backend. |
| `npm run types:openapi` | Regenerate backend API types from the OpenAPI schema. |
| `npm run migrate` | Apply metadata migrations using `DATABASE_URL`. |

The application uses TypeScript 7. The OpenAPI generator uses an isolated TypeScript 5.9 toolchain because it depends on the older compiler API. See [AGENTS.md](../AGENTS.md) for the repository's code map and change-coupling rules.

## Browser smoke test

```bash
npm --prefix frontend exec -- playwright install chromium
npm run test:e2e
```

The suite starts Vite and uses in-browser API fixtures. It checks sign-in, natural-language submission, keyboard operation, and automated accessibility rules. It does not verify a live LLM or reporting database. Pull request CI runs it after frontend lint and build.

## Schema-linking regression benchmark

```bash
npm run benchmark:large-schema
```

This provider-free benchmark compares hierarchical schema selection with the legacy global prompt. CI exercises 100, 300, and 1,000 distractor tables, requiring at least 95% table recall@15, 100% join-path accuracy, at most 15 candidates, and p95 linking latency below 250 ms. It also checks improvement over the legacy selection and prompt size.

These are schema-linking gates, not end-to-end SQL accuracy claims. Failures exit with code `2` and include gate diagnostics.

## Live SQL evaluation

The [DVD Rental benchmark](evals/dvdrental-mvp-benchmark.json) contains 60 reporting prompts, paired with reference SQL. The runner is `app/src/benchmark/runMvpBenchmark.ts` (`npm run benchmark:mvp`).

**Current integration gap:** the runner's HTTP helper does not sign in or send an authentication cookie, while the application requires authentication. Its existing command is not an end-to-end recipe for the current application. Add authenticated-session handling before using the runner for a release evaluation; do not disable application authorization to make it run. For a working small-scale check, use the [authenticated screenshot walkthrough](examples/dvd-rental.md).

The runner accepts `BENCHMARK_APP_BASE_URL`, `BENCHMARK_DATA_SOURCE_ID`, `BENCHMARK_CONNECTION_REF`, `BENCHMARK_ORACLE_CONN`, `BENCHMARK_PROVIDER`, `BENCHMARK_MODEL`, and `BENCHMARK_MAX_CASES`. The datasource connection must be reachable from the API; the oracle connection must be reachable from the runner. For an API running in Docker on macOS, this commonly means `host.docker.internal` for the datasource and `localhost` for a host-run oracle.

The runner writes JSON and Markdown reports under `docs/evals/reports`, persists a benchmark summary, and exits with code `2` if a release gate fails. Reports include accuracy, repairs, fallback use, schema-linking measures, prompt sizes, and stratification. Gates cap rule-based fallback at 10% of successful runs and require at least 80% successful repair when repairs are attempted.

Benchmark configuration and example fixtures do not establish a measured score. Publish the actual result, model, dataset, and run conditions when reporting accuracy.

## Observability and troubleshooting

Query diagnostics record bounded context identifiers, provider outcomes, stage timings, repair counts, prompt-size estimates, and token totals, correlated by request and session ID. The diagnostic event excludes the question, prompt, SQL, connection details, and raw provider errors.

Optional OpenTelemetry export is disabled by default. See [OpenTelemetry configuration](observability/opentelemetry.md).

`LLM_DEBUG_LOG=true` is a separate diagnostic mode that logs prompts and generated SQL. Keep it disabled when gathering public screenshots or using sensitive schema and business notes.

## Main code paths

| Area | Location |
| --- | --- |
| Frontend workspace and administration | `frontend/src/pages/` |
| API routes and authorization | `app/src/routes/`, `app/src/lib/authGate.ts` |
| Query orchestration | `app/src/services/queryOrchestrationService.ts` |
| RAG indexing and retrieval | `app/src/services/ragService.ts`, `ragRetrieval.ts` |
| Table selection and join expansion | `app/src/services/queryGenerationContextService.ts` |
| SQL safety and budgets | `app/src/services/sqlAstValidator.ts`, `sqlSafety.ts`, `queryBudget.ts` |
| Database and LLM integrations | `app/src/adapters/` |
| Metadata migrations | `db/migrations/` |

The [OpenAPI schema](api/openapi.yaml) is the endpoint reference. The [implementation tracker](../IMPLEMENTATION_PLAN.md) records development phases; the current code and observed runtime behavior define what works.
