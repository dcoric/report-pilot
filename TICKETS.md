# AI-DB Tickets

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

## Ticket BE-001: Query Result Export API (JSON, CSV, Excel, and Tabular Formats)

- Objective: Add backend export capability so UI can download query results in common file formats.
- Scope:
- New export endpoint for a completed query attempt.
- Supported formats: `json`, `csv`, `xlsx`, `tsv`, `parquet` (optional stretch: `ods`, `ndjson`).
- Streaming/chunked response for large result sets.
- Configurable file name + safe defaults (timestamp + question slug/attempt id).
- APIs:
- `POST /v1/query/sessions/{id}/export` (or `GET /v1/query/attempts/{attempt_id}/export?format=...`)
- Acceptance Criteria:
- Endpoint exports rows from a successful attempt without re-running LLM generation.
- `Content-Type` and `Content-Disposition` headers are correct per format.
- UTF-8 and delimiter/escaping rules are correct for CSV/TSV.
- Excel export preserves column headers and basic numeric/date typing.
- Export handles empty result sets and very large result sets without timeout/memory blowups.
- Access control mirrors existing query session ownership rules.
- API returns clear errors for unsupported formats.

---

## Suggested Delivery Sequence

- Sprint 1: UI-001, UI-002, UI-003, UI-004, UI-005
- Sprint 2: UI-006, UI-007, UI-008, UI-009
- Sprint 3: UI-010, UI-011, UI-012
- Sprint 4: UI-013, UI-014, UI-015, UI-016, BE-001

## Backend Dependencies / Notes for UI Team

- There are create/update endpoints for semantic/metric/join entities, but no dedicated list endpoints for those resources yet.
- For MVP UI, keep local state after create/update and provide a manual refresh action where needed.
- Introspection does not currently expose a job status endpoint; use schema polling strategy from UI-004.

---

## Post-MVP Tickets (Auth, RBAC, User Config)

## Ticket AUTH-001: Authentication Foundation (Login/Logout/Session)

- Objective: Add secure user authentication for the app.
- Scope:
- Support email/password or SSO (OIDC) login.
- Session handling with secure cookies or short-lived JWT + refresh.
- Logout endpoint and client logout flow.
- APIs:
- `POST /v1/auth/login`
- `POST /v1/auth/logout`
- `GET /v1/auth/me`
- Acceptance Criteria:
- Unauthenticated users are redirected to login.
- Authenticated users can access protected routes.
- Session expires correctly and refresh flow works.
- UI shows current user identity via `/v1/auth/me`.

## Ticket AUTH-002: User and Role Data Model

- Objective: Introduce core auth tables and role assignment.
- Scope:
- `users`, `roles`, `user_roles`, optional `permissions`, `role_permissions`.
- Migration scripts and seed roles (`admin`, `analyst`, `viewer`).
- APIs:
- `GET /v1/admin/users`
- `POST /v1/admin/users`
- `POST /v1/admin/users/{id}/roles`
- Acceptance Criteria:
- Roles can be assigned/revoked for a user.
- User-role membership is persisted and auditable.
- Default role assignment on user creation is enforced.

## Ticket AUTH-003: RBAC Enforcement Middleware (Backend)

- Objective: Enforce endpoint-level authorization across API surface.
- Scope:
- Central authorization middleware/policy checks.
- Route-to-permission mapping for admin vs analyst vs viewer actions.
- APIs: all protected endpoints.
- Acceptance Criteria:
- Unauthorized calls return `403`.
- Missing auth returns `401`.
- Admin-only endpoints are blocked for non-admin users.
- Authorization decisions are logged with user ID and request ID.

## Ticket AUTH-004: Frontend Route Guards and Permission-aware UI

- Objective: Ensure UI reflects user permissions and prevents invalid actions.
- Scope:
- Route guards and feature flags based on `me` payload.
- Hide/disable restricted actions (provider config, semantic edits, reindex, etc.).
- APIs:
- `GET /v1/auth/me`
- existing feature endpoints
- Acceptance Criteria:
- Unauthorized actions are not visible or are disabled with explanation.
- Direct URL navigation to restricted routes is blocked.
- Permission changes are reflected after re-auth/refresh.

## Ticket AUTH-005: Resource-level Permissions (Data Source Scoped Access)

- Objective: Restrict access per data source/resource, not just by global role.
- Scope:
- Data source membership mapping (`user_data_source_access`).
- Checks on query sessions, schema browsing, and semantic editing by source.
- APIs:
- existing data source/query/semantic endpoints
- Acceptance Criteria:
- User can only view/run against assigned data sources.
- Cross-source access attempts are denied with `403`.
- Admin can grant/revoke source access.

## Ticket AUTH-006: User Configuration Profiles

- Objective: Add per-user saved configuration and defaults.
- Scope:
- Persist UI/user settings: default data source, default provider/model, max rows, timeout, theme, table preferences.
- APIs:
- `GET /v1/users/me/config`
- `PUT /v1/users/me/config`
- Acceptance Criteria:
- User settings persist across sessions.
- Query page uses user defaults on load.
- Invalid config payloads are validated and rejected clearly.

## Ticket AUTH-007: Per-user Query Preferences and Saved Prompts

- Objective: Improve analyst productivity with personal presets.
- Scope:
- Saved prompt templates and favorite questions per user.
- Optional private/shared visibility.
- APIs:
- `GET /v1/users/me/prompt-presets`
- `POST /v1/users/me/prompt-presets`
- `PUT /v1/users/me/prompt-presets/{id}`
- `DELETE /v1/users/me/prompt-presets/{id}`
- Acceptance Criteria:
- User can save/edit/delete prompt presets.
- Presets can be applied directly in query workspace.
- Access is limited to owner unless explicitly shared.

## Ticket AUTH-008: Audit Trail for Auth and Permission Changes

- Objective: Add compliance-grade tracking for identity and access changes.
- Scope:
- Audit events for login/logout, failed login, role changes, permission changes.
- Admin audit page filters by user/action/date.
- APIs:
- `GET /v1/admin/audit-events`
- Acceptance Criteria:
- Role/permission mutations create audit entries.
- Auth events include timestamp, actor, and action outcome.
- Audit list supports pagination and filtering.

## Ticket AUTH-009: Security Hardening and Account Controls

- Objective: Add baseline account security controls.
- Scope:
- Password policy, login rate limiting, lockout/backoff, optional MFA-ready hooks.
- CSRF protection (if cookie sessions), secure headers, token rotation.
- APIs:
- auth endpoints
- Acceptance Criteria:
- Repeated failed logins trigger throttling/lockout.
- Password policy enforced server-side.
- Security headers and cookie flags (`HttpOnly`, `Secure`, `SameSite`) are set correctly.

## Suggested Post-MVP Sequence

- Phase A: AUTH-001, AUTH-002, AUTH-003, AUTH-004
- Phase B: AUTH-005, AUTH-006, AUTH-007
- Phase C: AUTH-008, AUTH-009

---

## Auth Federation Expansion (After Post-MVP)

## Ticket AUTH-010: OIDC Identity Provider Support

- Objective: Add standards-based OIDC login with external IdPs.
- Scope:
- OIDC authorization code + PKCE flow.
- Multi-tenant/provider configuration (issuer, client id/secret, scopes, redirect URLs).
- Claims mapping to internal user and role model.
- APIs:
- `POST /v1/admin/auth-providers` (create/update OIDC provider config)
- `GET /v1/admin/auth-providers`
- `GET /v1/auth/oidc/callback`
- Acceptance Criteria:
- Users can log in through at least one OIDC IdP (Okta/Auth0/Azure AD/Keycloak).
- ID token and userinfo claims are validated and mapped correctly.
- OIDC login works alongside existing auth method without regression.

## Ticket AUTH-011: Enterprise Auth Methods (SAML, LDAP/AD, PD)

- Objective: Support additional enterprise identity systems beyond OIDC.
- Scope:
- SAML 2.0 SSO integration.
- LDAP/Active Directory bind/auth integration.
- PD support (PingDirectory/PingFederate style enterprise IdP integration).
- APIs:
- `POST /v1/admin/auth-providers` with provider type: `saml`, `ldap`, `ad`, `pd`
- `POST /v1/auth/saml/callback`
- Acceptance Criteria:
- Each enabled provider type can authenticate a user end-to-end.
- Provider-specific settings are validated before activation.
- Failover message is clear when provider is unreachable or misconfigured.

## Ticket AUTH-012: Account Linking and JIT Provisioning

- Objective: Allow one internal user identity across multiple auth providers.
- Scope:
- Just-in-time user provisioning on first successful external login.
- Account linking rules by email/subject and safe conflict handling.
- Optional domain allowlist for auto-provisioning.
- APIs:
- `POST /v1/admin/auth-providers/{id}/mapping-rules`
- `GET /v1/admin/users/{id}/linked-identities`
- Acceptance Criteria:
- First login via OIDC/SAML/LDAP/PD can create user automatically when allowed.
- Existing users can be linked to external identities without duplicate accounts.
- Conflicts are logged and shown with actionable admin error messages.

## Ticket AUTH-013: SCIM Provisioning (Optional but Recommended)

- Objective: Support enterprise user/role lifecycle sync from IdP.
- Scope:
- SCIM 2.0 endpoints for user and group provisioning.
- Group-to-role mapping for RBAC assignment.
- APIs:
- `/scim/v2/Users`
- `/scim/v2/Groups`
- Acceptance Criteria:
- Create/update/deactivate users via SCIM is reflected in app.
- Group membership updates map to roles deterministically.
- SCIM auth and audit logging are enforced.

## Ticket AUTH-014: Auth Provider Admin UI

- Objective: Add admin UI for managing OIDC and other auth providers.
- Scope:
- CRUD screens for provider configs, status, test-connection action.
- Mapping rule editor (claims/groups -> roles/permissions).
- APIs:
- `GET/POST /v1/admin/auth-providers`
- related mapping/test endpoints
- Acceptance Criteria:
- Admin can add and activate multiple providers.
- Provider health/test result is visible in UI.
- Misconfiguration errors are surfaced clearly with field-level hints.

## Ticket AUTH-015: Federation Security Hardening

- Objective: Harden external auth integrations for production.
- Scope:
- Strict nonce/state validation, replay protection, clock-skew handling.
- Key rotation and JWKS refresh handling.
- SAML signature/certificate rotation support.
- APIs: auth/federation endpoints
- Acceptance Criteria:
- Invalid tokens/assertions are rejected with secure error responses.
- Key/certificate rotation does not cause downtime.
- Security events are audited and exportable.

## Suggested Federation Sequence

- Phase D: AUTH-010, AUTH-014
- Phase E: AUTH-011, AUTH-012
- Phase F: AUTH-015
- Phase G (optional): AUTH-013
