// AUTH-003: route-to-permission mapping. Each entry pairs a method + path
// pattern with one of:
//   - `public: true`     — no auth required (login, health, openapi, etc.)
//   - `role: "<name>"`   — must have the named role (currently only used for admin endpoints)
//   - `permission: "<name>"` — must have the named permission
//
// The enforcer (lib/authGate.enforcePolicy) walks the list in order and uses
// the first match. Any /v1/* path without a matching policy is treated as an
// unknown endpoint and returns 404 — there is no implicit "open" policy.

export type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE" | "OPTIONS" | "HEAD";

export interface RoutePolicy {
  method: HttpMethod;
  pattern: RegExp;
  public?: boolean;
  role?: string;
  permission?: string;
}

export const POLICIES: ReadonlyArray<RoutePolicy> = [
  // Service / docs
  { method: "GET", pattern: /^\/health$/, public: true },
  { method: "GET", pattern: /^\/ready$/, public: true },
  { method: "GET", pattern: /^\/$/, public: true },
  { method: "GET", pattern: /^\/docs\/?$/, public: true },
  { method: "GET", pattern: /^\/openapi\.yaml$/, public: true },

  // Auth surface — login/logout/me must be reachable without a session
  { method: "POST", pattern: /^\/v1\/auth\/login$/, public: true },
  { method: "POST", pattern: /^\/v1\/auth\/logout$/, public: true },
  { method: "GET", pattern: /^\/v1\/auth\/me$/, public: true },
  { method: "GET", pattern: /^\/v1\/auth\/oidc\/providers$/, public: true },
  { method: "GET", pattern: /^\/v1\/auth\/oidc\/login$/, public: true },
  { method: "GET", pattern: /^\/v1\/auth\/oidc\/callback$/, public: true },

  // AUTH-006 — self-service config (any authenticated role)
  { method: "GET", pattern: /^\/v1\/users\/me\/config$/, permission: "users.read_self" },
  { method: "PUT", pattern: /^\/v1\/users\/me\/config$/, permission: "users.write_self" },

  // AUTH-007 — per-user prompt presets (any authenticated role)
  { method: "GET", pattern: /^\/v1\/users\/me\/prompt-presets$/, permission: "users.read_self" },
  { method: "POST", pattern: /^\/v1\/users\/me\/prompt-presets$/, permission: "users.write_self" },
  { method: "PUT", pattern: /^\/v1\/users\/me\/prompt-presets\/[^/]+$/, permission: "users.write_self" },
  { method: "DELETE", pattern: /^\/v1\/users\/me\/prompt-presets\/[^/]+$/, permission: "users.write_self" },

  // Admin
  { method: "GET", pattern: /^\/v1\/admin\/users$/, role: "admin" },
  { method: "POST", pattern: /^\/v1\/admin\/users$/, role: "admin" },
  { method: "POST", pattern: /^\/v1\/admin\/users\/[^/]+\/roles$/, role: "admin" },
  { method: "GET", pattern: /^\/v1\/admin\/data-sources\/[^/]+\/access$/, role: "admin" },
  { method: "POST", pattern: /^\/v1\/admin\/data-sources\/[^/]+\/access$/, role: "admin" },
  { method: "DELETE", pattern: /^\/v1\/admin\/data-sources\/[^/]+\/access\/[^/]+$/, role: "admin" },
  { method: "GET", pattern: /^\/v1\/admin\/auth-providers$/, role: "admin" },
  { method: "POST", pattern: /^\/v1\/admin\/auth-providers$/, role: "admin" },
  { method: "DELETE", pattern: /^\/v1\/admin\/auth-providers\/[^/]+$/, role: "admin" },
  { method: "POST", pattern: /^\/v1\/admin\/auth-providers\/[^/]+\/test$/, role: "admin" },
  { method: "POST", pattern: /^\/v1\/admin\/auth-providers\/[^/]+\/mapping-rules$/, role: "admin" },
  { method: "POST", pattern: /^\/v1\/admin\/auth-providers\/[^/]+\/scim-group-mappings$/, role: "admin" },
  { method: "GET", pattern: /^\/v1\/admin\/auth-providers\/[^/]+\/scim-tokens$/, role: "admin" },
  { method: "POST", pattern: /^\/v1\/admin\/auth-providers\/[^/]+\/scim-tokens$/, role: "admin" },
  { method: "DELETE", pattern: /^\/v1\/admin\/auth-providers\/[^/]+\/scim-tokens\/[^/]+$/, role: "admin" },
  { method: "GET", pattern: /^\/v1\/admin\/users\/[^/]+\/linked-identities$/, role: "admin" },
  { method: "DELETE", pattern: /^\/v1\/admin\/users\/[^/]+\/linked-identities\/[^/]+$/, role: "admin" },
  { method: "GET", pattern: /^\/v1\/admin\/audit-events$/, role: "admin" },

  // Data sources
  { method: "GET", pattern: /^\/v1\/data-sources$/, permission: "data_sources.read" },
  { method: "POST", pattern: /^\/v1\/data-sources$/, permission: "data_sources.write" },
  { method: "POST", pattern: /^\/v1\/data-sources\/import$/, permission: "data_sources.write" },
  { method: "DELETE", pattern: /^\/v1\/data-sources\/[^/]+$/, permission: "data_sources.write" },
  { method: "POST", pattern: /^\/v1\/data-sources\/[^/]+\/introspect$/, permission: "data_sources.write" },
  { method: "POST", pattern: /^\/v1\/data-sources\/[^/]+\/import-schema$/, permission: "data_sources.write" },
  { method: "GET", pattern: /^\/v1\/data-sources\/[^/]+\/export$/, permission: "data_sources.read" },

  // Schema metadata
  { method: "GET", pattern: /^\/v1\/schema-objects$/, permission: "data_sources.read" },
  { method: "PATCH", pattern: /^\/v1\/schema-objects\/[^/]+$/, permission: "semantic.write" },

  // Semantic edits
  { method: "POST", pattern: /^\/v1\/semantic-entities$/, permission: "semantic.write" },
  { method: "POST", pattern: /^\/v1\/metric-definitions$/, permission: "semantic.write" },
  { method: "POST", pattern: /^\/v1\/join-policies$/, permission: "semantic.write" },

  // Query (NL → SQL execution path)
  { method: "POST", pattern: /^\/v1\/query\/sessions$/, permission: "query.run" },
  { method: "GET", pattern: /^\/v1\/query\/prompts\/history$/, permission: "query.run" },
  { method: "POST", pattern: /^\/v1\/query\/sessions\/[^/]+\/run$/, permission: "query.run" },
  { method: "POST", pattern: /^\/v1\/query\/sessions\/[^/]+\/feedback$/, permission: "query.run" },
  { method: "POST", pattern: /^\/v1\/query\/sessions\/[^/]+\/export$/, permission: "query.run" },
  { method: "POST", pattern: /^\/v1\/query\/sessions\/[^/]+\/export\/deliver$/, permission: "query.run" },
  { method: "GET", pattern: /^\/v1\/exports\/[^/]+\/status$/, permission: "query.run" },

  // Saved queries — list/get/validate are reads, write/delete are writes, run is query.run,
  // share is QUERY-006's owner-only re-distribution permission.
  { method: "GET", pattern: /^\/v1\/saved-queries$/, permission: "saved_queries.read" },
  { method: "POST", pattern: /^\/v1\/saved-queries$/, permission: "saved_queries.write" },
  { method: "POST", pattern: /^\/v1\/saved-queries\/[^/]+\/validate-params$/, permission: "saved_queries.read" },
  { method: "POST", pattern: /^\/v1\/saved-queries\/[^/]+\/run$/, permission: "query.run" },
  { method: "POST", pattern: /^\/v1\/saved-queries\/[^/]+\/share$/, permission: "saved_queries.share" },
  { method: "GET", pattern: /^\/v1\/saved-queries\/[^/]+\/access$/, permission: "saved_queries.read" },
  { method: "GET", pattern: /^\/v1\/saved-queries\/[^/]+\/versions$/, permission: "saved_queries.read" },
  { method: "POST", pattern: /^\/v1\/saved-queries\/[^/]+\/versions\/[^/]+\/restore$/, permission: "saved_queries.write" },
  // QUERY-007: scheduled delivery. Both create / read / update / delete and the
  // explicit retry endpoint live under saved_queries.schedule (granted to admin
  // + analyst by default). Service-layer enforcement adds owner-only on top.
  { method: "POST", pattern: /^\/v1\/saved-queries\/[^/]+\/schedules$/, permission: "saved_queries.schedule" },
  { method: "GET", pattern: /^\/v1\/saved-queries\/[^/]+\/schedules$/, permission: "saved_queries.schedule" },
  { method: "PUT", pattern: /^\/v1\/saved-queries\/[^/]+\/schedules\/[^/]+$/, permission: "saved_queries.schedule" },
  { method: "DELETE", pattern: /^\/v1\/saved-queries\/[^/]+\/schedules\/[^/]+$/, permission: "saved_queries.schedule" },
  { method: "POST", pattern: /^\/v1\/saved-queries\/[^/]+\/schedules\/[^/]+\/retry$/, permission: "saved_queries.schedule" },
  // QUERY-008: foldering. CRUD on folders + the move endpoint share the
  // saved_queries.write permission with create/update/delete on saved queries
  // — there's no point being able to author a query but not file it. List is
  // a read so viewers still see the tree shape if they have read access.
  { method: "POST", pattern: /^\/v1\/saved-query-folders$/, permission: "saved_queries.write" },
  { method: "GET", pattern: /^\/v1\/saved-query-folders$/, permission: "saved_queries.read" },
  { method: "PUT", pattern: /^\/v1\/saved-query-folders\/[^/]+$/, permission: "saved_queries.write" },
  { method: "DELETE", pattern: /^\/v1\/saved-query-folders\/[^/]+$/, permission: "saved_queries.write" },
  { method: "POST", pattern: /^\/v1\/saved-queries\/[^/]+\/move$/, permission: "saved_queries.write" },
  { method: "GET", pattern: /^\/v1\/saved-queries\/[^/]+$/, permission: "saved_queries.read" },
  { method: "PUT", pattern: /^\/v1\/saved-queries\/[^/]+$/, permission: "saved_queries.write" },
  { method: "DELETE", pattern: /^\/v1\/saved-queries\/[^/]+$/, permission: "saved_queries.write" },

  // Providers / routing
  { method: "GET", pattern: /^\/v1\/llm\/providers$/, permission: "providers.read" },
  { method: "POST", pattern: /^\/v1\/llm\/providers$/, permission: "providers.write" },
  { method: "POST", pattern: /^\/v1\/llm\/routing-rules$/, permission: "providers.write" },
  { method: "GET", pattern: /^\/v1\/health\/providers$/, permission: "providers.read" },

  // Observability
  { method: "GET", pattern: /^\/v1\/observability\/metrics$/, permission: "observability.read" },
  { method: "GET", pattern: /^\/v1\/observability\/release-gates$/, permission: "observability.read" },
  { method: "GET", pattern: /^\/v1\/observability\/benchmark-command$/, permission: "observability.read" },
  { method: "POST", pattern: /^\/v1\/observability\/release-gates\/report$/, permission: "observability.write" },

  // RAG notes — reads are tied to data-source read access; writes need rag.write.
  { method: "GET", pattern: /^\/v1\/rag\/notes$/, permission: "data_sources.read" },
  { method: "POST", pattern: /^\/v1\/rag\/notes$/, permission: "rag.write" },
  { method: "DELETE", pattern: /^\/v1\/rag\/notes\/[^/]+$/, permission: "rag.write" },
  { method: "POST", pattern: /^\/v1\/rag\/reindex$/, permission: "rag.write" }
];

export function findPolicy(method: string, pathname: string): RoutePolicy | null {
  for (const policy of POLICIES) {
    if (policy.method !== method) continue;
    if (!policy.pattern.test(pathname)) continue;
    return policy;
  }
  return null;
}

export function describePolicy(policy: RoutePolicy | null | undefined): string {
  if (!policy) return "unmapped";
  if (policy.public) return "public";
  if (policy.role) return `role:${policy.role}`;
  if (policy.permission) return `permission:${policy.permission}`;
  return "unmapped";
}
