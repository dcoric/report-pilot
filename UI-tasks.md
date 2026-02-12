# AI-DB UI Tasks

## Epic: MVP UI for NL-to-SQL with RAG-Grounded Reporting

### Epic Goal
Build a production-ready internal UI that lets an analyst:
- connect and introspect a data source,
- manage semantic and join context used by RAG,
- ask natural-language questions and inspect generated SQL/results/citations,
- provide feedback to improve future query quality,
- monitor provider health and release-readiness signals.

### Initial App Config (must be done first)
- Frontend stack: React + TypeScript + Vite (or Next.js App Router if team standard).
- API base URL config via env var: `VITE_API_BASE_URL` (default `http://localhost:8080`).
- Single shared API client with request/response typing from OpenAPI.
- Global error handling and toast system for API failures.
- Standard page layout with left navigation and route-level loading states.
- Auth placeholder: include request interceptor for `x-user-id` header (hardcoded for local MVP).
- Add CI checks: lint, type-check, unit test, build.

### Epic Definition of Done
- All tickets below are shipped and integrated.
- A new user can complete full flow: data source -> introspection -> question -> feedback.
- UI handles success, loading, empty, and error states on every page.
- No blocking console errors in local run.

---

## Ticket UI-001: App Shell and Routing

- Objective: Create base app layout, navigation, route skeletons.
- Scope: Nav + pages for Data Sources, Schema, Semantic, Query, Providers, Observability.
- APIs: none (layout only).
- Acceptance Criteria:
- Routes exist and render placeholder content.
- Active route highlighting works.
- 404 page exists.

## Ticket UI-002: Typed API Client and Error Model

- Objective: Build reusable API layer with typed request/response wrappers.
- Scope: `GET/POST` wrapper, timeout, error normalization, retry policy (read-only requests only).
- APIs: all endpoints in `/docs` OpenAPI.
- Acceptance Criteria:
- Every feature page uses shared client.
- API errors are displayed as user-friendly messages.
- Request IDs from response headers are logged for debugging.

## Ticket UI-003: Data Source Management

- Objective: Let user create and list data sources.
- Scope: List table + create form modal.
- APIs:
- `GET /v1/data-sources`
- `POST /v1/data-sources`
- Acceptance Criteria:
- User can add Postgres source (name, db type, connection ref).
- New data source appears in list without full page refresh.
- Validation errors are shown inline.

## Ticket UI-004: Introspection Flow and Status UX

- Objective: Trigger introspection and provide status feedback.
- Scope: “Introspect” action on selected data source, progress indicator, completion confirmation.
- APIs:
- `POST /v1/data-sources/{id}/introspect`
- `GET /v1/schema-objects?data_source_id=...`
- Acceptance Criteria:
- User can trigger introspection from list/detail view.
- UI shows pending/running state.
- Completion is inferred by polling schema objects until non-empty.
- Failure state is shown when timeout threshold is reached.

## Ticket UI-005: Schema Explorer

- Objective: Display introspected schema objects for selected data source.
- Scope: Search/filter/sort schema object list.
- APIs:
- `GET /v1/schema-objects?data_source_id=...`
- Acceptance Criteria:
- User can filter by schema/object name.
- Empty state explains that introspection is required.
- Object type and description are visible.

## Ticket UI-006: Semantic Entity Editor

- Objective: Create/update semantic entities used by RAG.
- Scope: Form for table/column/metric/dimension/rule entities.
- APIs:
- `POST /v1/semantic-entities`
- Acceptance Criteria:
- User can create semantic entity with required fields.
- Edit mode supported via `id` in payload.
- Success toast confirms that reindex is auto-triggered asynchronously.

## Ticket UI-007: Metric Definition Editor

- Objective: Create/update metric SQL definitions.
- Scope: Form with semantic entity ID, SQL expression, grain, optional filters JSON.
- APIs:
- `POST /v1/metric-definitions`
- Acceptance Criteria:
- Required fields validated client-side.
- JSON field validation for `filters_json`.
- Save success and error states handled.

## Ticket UI-008: Join Policy Editor

- Objective: Create/update approved join policies.
- Scope: Form for left/right refs, join type, on-clause, approved flag, notes.
- APIs:
- `POST /v1/join-policies`
- Acceptance Criteria:
- Approved policies can be created and edited.
- Validation ensures all required fields are supplied.
- Save result shown with returned policy ID.

## Ticket UI-009: RAG Reindex Console Action

- Objective: Give admins explicit reindex control.
- Scope: Button/action on semantic/schema screens.
- APIs:
- `POST /v1/rag/reindex?data_source_id=...`
- Acceptance Criteria:
- Reindex can be manually triggered.
- Result shows documents indexed and embedding model.
- Error state includes returned API message.

## Ticket UI-010: Query Workspace (NL Question -> Run)

- Objective: Core analyst experience for creating/running query sessions.
- Scope: Question input, run controls (`provider/model/max_rows/timeout_ms`), session creation and execution.
- APIs:
- `POST /v1/query/sessions`
- `POST /v1/query/sessions/{id}/run`
- Acceptance Criteria:
- User can submit question and run in one flow.
- SQL, columns, rows, duration, provider, confidence are shown.
- SQL block is copyable.
- Large row sets are virtualized/paginated in UI.

## Ticket UI-011: Query Citations and RAG Debug Panel

- Objective: Expose grounding details for trust and debugging.
- Scope: Collapsible panel for schema/semantic/metric/join citations and `rag_documents`.
- APIs:
- Uses `/v1/query/sessions/{id}/run` response payload.
- Acceptance Criteria:
- Citations are grouped by type.
- RAG docs show score and rerank score.
- Empty citation states are shown clearly.

## Ticket UI-012: Feedback Capture UX

- Objective: Collect rating and corrected SQL from users.
- Scope: Feedback form attached to latest query result.
- APIs:
- `POST /v1/query/sessions/{id}/feedback`
- Acceptance Criteria:
- Rating 1-5 enforced.
- Optional corrected SQL and comment supported.
- UI shows whether corrected SQL was saved as an example.

## Ticket UI-013: Provider Config and Routing UI

- Objective: Manage LLM providers and routing rules per data source.
- Scope: Provider settings panel + routing rule form.
- APIs:
- `POST /v1/llm/providers`
- `POST /v1/llm/routing-rules`
- `GET /v1/health/providers`
- Acceptance Criteria:
- User can enable/disable provider, set default model, and API key ref.
- User can configure primary/fallback providers for a data source.
- Provider health shown with status badges.

## Ticket UI-014: Observability Dashboard

- Objective: Provide operational visibility for query quality and reliability.
- Scope: Metrics cards + charts + provider failure table.
- APIs:
- `GET /v1/observability/metrics?window_hours=...`
- Acceptance Criteria:
- User can switch time window.
- Generation and execution latency stats are visible.
- Token usage, query cost metrics, provider failures are visible.

## Ticket UI-015: Release Gates View

- Objective: Show MVP release readiness from benchmark reports.
- Scope: Dedicated page for latest release gate status.
- APIs:
- `GET /v1/observability/release-gates`
- Acceptance Criteria:
- PASS/FAIL badges per gate.
- Shows run date and source report metadata.
- Handles no-report (`404`) state with clear CTA.

## Ticket UI-016: QA and UX Hardening

- Objective: Validate all flows and edge cases before MVP signoff.
- Scope: e2e happy path tests, API error path tests, loading/empty states review.
- APIs: all UI-used endpoints.
- Acceptance Criteria:
- End-to-end smoke test for full flow passes locally.
- Error boundaries and retry actions exist on all critical pages.
- Accessibility basics pass (keyboard nav, labels, focus states).

---

## Suggested Delivery Sequence

- Sprint 1: UI-001, UI-002, UI-003, UI-004, UI-005
- Sprint 2: UI-006, UI-007, UI-008, UI-009
- Sprint 3: UI-010, UI-011, UI-012
- Sprint 4: UI-013, UI-014, UI-015, UI-016

## Backend Dependencies / Notes for UI Team

- There are create/update endpoints for semantic/metric/join entities, but no dedicated list endpoints for those resources yet.
- For MVP UI, keep local state after create/update and provide a manual refresh action where needed.
- Introspection does not currently expose a job status endpoint; use schema polling strategy from UI-004.
