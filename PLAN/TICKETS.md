# Report Pilot Tickets

## Epic: MVP UI for NL-to-SQL with RAG-Grounded Reporting

### Epic Goal
Build a production-ready internal UI that lets an analyst:
- connect and introspect a data source,
- manage semantic and join context used by RAG,
- ask natural-language questions and inspect generated SQL/results/citations,
- provide feedback to improve future query quality,
- monitor provider health and release-readiness signals.

### Primary UX Layout (Product Direction)
- Overall layout should follow a phpMyAdmin-like structure.
- Left sidebar: connections tree that expands/collapses and surfaces saved reports.
- Saved reports should support folder grouping for organization.
- Main workspace: prompt input at top, generated SQL editor below it, result table below SQL.
- Primary execute action is a clear play/run button near the SQL editor.
- Bottom action bar should include export options with delivery mode (`download` or `email`).

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

## Ticket UI-017: Sidebar Tree UX (Connections -> Reports -> Folders)

- Objective: Implement left navigation as a hierarchical tree for fast switching.
- Scope:
- Connection nodes in sidebar.
- Under each connection, stored reports grouped by folders.
- Expand/collapse state persistence per user/session.
- APIs:
- `GET /v1/data-sources`
- saved query endpoints from QUERY phase
- Acceptance Criteria:
- User can expand a connection and browse folders/reports.
- Tree supports deep nesting for folders.
- Selected report loads into main workspace.

## Ticket UI-016: QA and UX Hardening

- Objective: Validate all flows and edge cases before MVP signoff.
- Scope: e2e happy path tests, API error path tests, loading/empty states review.
- APIs: all UI-used endpoints.
- Acceptance Criteria:
- End-to-end smoke test for full flow passes locally.
- Error boundaries and retry actions exist on all critical pages.
- Accessibility basics pass (keyboard nav, labels, focus states).

## Ticket UI-020: Prompt History in Query Workspace

- Objective: Let users view and reuse prior prompts to speed up iterative analysis.
- Scope:
- Persist prompt history per user (and optionally per data source/session context).
- Add a prompt history panel/dropdown in Query Workspace with search and recency ordering.
- Allow one-click reuse of a previous prompt into the input box.
- APIs:
- `GET /v1/query/prompts/history`
- `POST /v1/query/prompts/history` (or integrate write-on-run in existing run/session endpoint)
- Acceptance Criteria:
- Prompt history is visible in Query Workspace and ordered by newest first.
- User can select a historical prompt and populate the current prompt input.
- History view handles empty state and large history lists gracefully.

## Ticket UI-021: Edit API Key for Existing LLM Provider

- Objective: Allow secure API key updates for already configured providers.
- Scope:
- Add “Edit API Key” action in LLM Provider management UI.
- Key input is masked and never shows previously stored key material.
- Support provider key rotation without recreating the provider record.
- APIs:
- `PATCH /v1/llm/providers/{id}` (or `POST /v1/llm/providers` with update semantics)
- Acceptance Criteria:
- User can update API key for an existing provider from the UI.
- Existing key is not exposed in plaintext in API responses or UI.
- Updated key is used on subsequent provider health checks/query runs.

## Ticket UI-022: Custom LLM Provider Support (Local API / Custom URL / API Key)

- Objective: Support non-predefined/custom LLM providers for local/self-hosted or third-party compatible APIs.
- Scope:
- Extend provider form to include a custom provider type.
- Allow custom base URL, API key, model default, and provider display name.
- Validate URL format and connection test/health status for custom providers.
- APIs:
- `POST /v1/llm/providers`
- `GET /v1/llm/providers`
- `GET /v1/health/providers`
- Acceptance Criteria:
- User can create a provider with a custom/local API base URL and API key.
- Custom provider appears in provider lists and can be enabled/disabled like built-in providers.
- Query Workspace can select and run with an enabled custom provider.

## Ticket UI-023: Monaco SQL Editor + In-Editor Formatting

- Objective: Upgrade Query Workspace SQL editing with Monaco and reliable formatting.
- Scope:
- Replace SQL textarea with `@monaco-editor/react` in Query Workspace.
- Keep SQL value synchronized with existing query session state.
- Wire existing `Format SQL` action to Monaco document formatting.
- Register SQL formatting provider via `sql-formatter` (PostgreSQL dialect).
- APIs:
- none (frontend-only UX improvement)
- Acceptance Criteria:
- SQL section renders Monaco editor with SQL syntax highlighting.
- Editing SQL updates the same state used by run/copy/reset actions.
- Clicking `Format SQL` reformats SQL content inside the editor.
- Read-only mode keeps editor non-editable and disables format action.

---

## Suggested Delivery Sequence

- Sprint 1: UI-001, UI-002, UI-003, UI-004, UI-005
- Sprint 2: UI-006, UI-007, UI-008, UI-009
- Sprint 3: UI-010, UI-011, UI-012
- Sprint 4: UI-013, UI-014, UI-015, UI-016, BE-001
- Sprint 5: UI-017, UI-018, BE-002

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

---

## Saved Reports Expansion (After Federation)

## Ticket QUERY-001: Saved Query Data Model and APIs

- Objective: Allow users to save a generated report query with a name for future reuse.
- Scope:
- Add persistence model for saved queries (owner, name, description, data source, SQL, default run params).
- Add CRUD APIs for saved queries.
- APIs:
- `POST /v1/saved-queries`
- `GET /v1/saved-queries`
- `GET /v1/saved-queries/{id}`
- `PUT /v1/saved-queries/{id}`
- `DELETE /v1/saved-queries/{id}`
- Acceptance Criteria:
- User can save current query with required name.
- User sees only permitted saved queries (respecting auth/roles).
- Name collisions handled clearly (validation or auto-version policy).

## Ticket QUERY-002: Parameterized Query Support

- Objective: Support editable parameters when loading saved queries.
- Scope:
- Define parameter schema (name, type, required, default, allowed values).
- Support SQL placeholders (for example `:start_date`, `:country`) and safe binding.
- APIs:
- `POST /v1/saved-queries/{id}/validate-params`
- `POST /v1/saved-queries/{id}/run`
- Acceptance Criteria:
- User can modify params before execution.
- Backend validates and safely binds params (no string interpolation risk).
- Query runs successfully with defaults and with manual overrides.

## Ticket QUERY-003: Saved Query Library UI

- Objective: Provide list/search/filter UI for saved report queries.
- Scope:
- New page with table/grid of saved queries and metadata.
- Quick actions: load, edit metadata, duplicate, delete.
- APIs:
- `GET /v1/saved-queries`
- `DELETE /v1/saved-queries/{id}`
- Acceptance Criteria:
- User can find saved query by name and load in one click.
- Empty/loading/error states are handled.
- Deletion requires confirmation and updates list without full reload.

## Ticket QUERY-004: Query Workspace Integration (Load -> Edit Params -> Run)

- Objective: Integrate saved query execution into existing query workspace.
- Scope:
- “Save query” action after successful run.
- “Load saved query” action that injects SQL and params into run form.
- APIs:
- `POST /v1/saved-queries`
- `GET /v1/saved-queries/{id}`
- `POST /v1/saved-queries/{id}/run`
- Acceptance Criteria:
- User can load saved query, adjust params manually, and click run.
- Workspace shows loaded query source and last modified info.
- Run results, citations, and feedback flow still work unchanged.

## Ticket QUERY-005: Versioning and Change History (Recommended)

- Objective: Preserve previous revisions of saved queries for safety and rollback.
- Scope:
- Revision history table with who/when/what changed.
- Restore previous revision action.
- APIs:
- `GET /v1/saved-queries/{id}/versions`
- `POST /v1/saved-queries/{id}/versions/{version_id}/restore`
- Acceptance Criteria:
- Every edit creates a new revision entry.
- User can compare and restore previous SQL/params.
- Audit links changes to authenticated user.

## Ticket QUERY-006: Sharing and Access Control for Saved Queries

- Objective: Allow controlled sharing of saved report queries across users/teams.
- Scope:
- Visibility modes: private, team/shared, org (as permitted by role).
- Permission checks for view/edit/run/share.
- APIs:
- `POST /v1/saved-queries/{id}/share`
- `GET /v1/saved-queries/{id}/access`
- Acceptance Criteria:
- Owner can share/unshare according to role policy.
- Shared queries appear in recipient library.
- Unauthorized users cannot access unshared private queries.

## Ticket QUERY-007: Scheduled Report Delivery (Email + Format)

- Objective: Schedule saved queries and deliver outputs to email in selected format.
- Scope:
- Scheduler config for recurrence, timezone, recipients, delivery mode, and format.
- Delivery target support: `email` (initial) and `download artifact` retention for manual retrieval.
- Per-schedule parameter defaults/overrides.
- APIs:
- `POST /v1/saved-queries/{id}/schedules`
- `GET /v1/saved-queries/{id}/schedules`
- `PUT /v1/saved-queries/{id}/schedules/{schedule_id}`
- `DELETE /v1/saved-queries/{id}/schedules/{schedule_id}`
- Acceptance Criteria:
- User can create a schedule with recipient email(s) and chosen output format.
- Scheduled run sends report to email(s) and logs delivery outcome.
- Failed sends are retriable and visible in schedule status/history.
- Manual run path remains unchanged.

## Ticket QUERY-008: Saved Report Foldering Model

- Objective: Support folder-based organization for saved reports.
- Scope:
- Folder entity with parent-child hierarchy per user/team scope.
- Saved query -> folder relationship.
- CRUD for folders and move report between folders.
- APIs:
- `POST /v1/saved-query-folders`
- `GET /v1/saved-query-folders`
- `PUT /v1/saved-query-folders/{id}`
- `DELETE /v1/saved-query-folders/{id}`
- `POST /v1/saved-queries/{id}/move`
- Acceptance Criteria:
- User can create nested folders and organize saved reports.
- Folder delete behavior is deterministic (block, reassign, or cascade per policy).
- Move operation updates sidebar tree immediately.

## Ticket QUERY-009: Saved Query Sidebar Integration

- Objective: Connect saved query + folder APIs to the left navigation tree.
- Scope:
- Load tree by selected connection.
- Search/filter within folders.
- Drag-and-drop (optional) for report reorganization.
- APIs:
- `GET /v1/saved-queries`
- folder APIs from `QUERY-008`
- Acceptance Criteria:
- Sidebar reflects folders and reports in a stable hierarchy.
- Clicking report node loads prompt/SQL/params into workspace.
- User can reorganize reports between folders.

## Suggested Saved Query Sequence

- Phase H: QUERY-001, QUERY-003, QUERY-004
- Phase I: QUERY-002, QUERY-006
- Phase J: QUERY-005, QUERY-008, QUERY-009
- Phase K: QUERY-007
