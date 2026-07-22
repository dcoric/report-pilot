/**
 * Hand-written domain types for Report Pilot.
 *
 * These types describe the shapes of rows persisted in the metadata
 * Postgres database (defined by `db/migrations/0001_*.sql` through
 * `db/migrations/0030_*.sql`) plus a handful of in-process config
 * shapes (provider configs, routing) that are not exposed through the
 * OpenAPI spec.
 *
 * Conventions used throughout this file:
 *
 *   - UUID columns are typed as `string`.
 *   - Timestamps (`TIMESTAMPTZ`) are typed as `string`. The Node `pg`
 *     driver returns timestamps as Date instances by default, but the
 *     services in this repo serialize them through `JSON.stringify`
 *     (e.g. when persisting JSONB blobs or sending API responses), so
 *     ISO-8601 strings are the shape downstream code actually consumes.
 *     Callers that need a Date should construct one explicitly with
 *     `new Date(value)`.
 *   - Nullable columns are `T | null` (never `T | undefined`).
 *   - SQL CHECK enums become string-literal union types.
 *   - `JSONB` columns are typed as the most specific shape possible.
 *     Where the shape is intentionally free-form (e.g. AUTH-006's
 *     user config blob), we use `Record<string, unknown>` rather than
 *     `any` so callers must narrow.
 *
 * TS-004 is types-only: no runtime code imports these yet. The service
 * and route layers will pick them up incrementally as `.js` files are
 * migrated to `.ts`.
 */

// ---------------------------------------------------------------------------
// Shared primitives
// ---------------------------------------------------------------------------

/** ISO-8601 timestamp string (e.g. `"2026-05-23T19:00:00.000Z"`). */
export type IsoDateString = string;

/** Stringified UUID. */
export type UUID = string;

// ---------------------------------------------------------------------------
// Data sources (migrations 0001, 0006)
// ---------------------------------------------------------------------------

/** Supported database backends. 0006 expanded the set from {postgres} to {postgres, mssql}. */
export type DataSourceDbType = 'postgres' | 'mssql';

/**
 * `data_sources` row.
 *
 * Sources of truth:
 *   - 0001_core_metadata.sql (initial shape)
 *   - 0006_add_mssql_data_source.sql (db_type CHECK constraint widened)
 */
export interface DataSource {
    id: UUID;
    name: string;
    db_type: DataSourceDbType;
    connection_ref: string;
    /** Free-form lifecycle flag. Default `'active'`. */
    status: string;
    created_at: IsoDateString;
}

// ---------------------------------------------------------------------------
// Schema objects + columns + relationships (migrations 0001, 0008)
// ---------------------------------------------------------------------------

export type SchemaObjectType = 'table' | 'view' | 'materialized_view';

/**
 * `schema_objects` row.
 *
 * Sources of truth:
 *   - 0001_core_metadata.sql
 *   - 0008_schema_object_ignore_flag.sql (`is_ignored` added)
 */
export interface SchemaObject {
    id: UUID;
    data_source_id: UUID;
    object_type: SchemaObjectType;
    schema_name: string;
    object_name: string;
    description: string | null;
    hash: string;
    last_seen_at: IsoDateString;
    created_at: IsoDateString;
    /** Added in 0008. True when an admin has marked the object hidden from the assistant. */
    is_ignored: boolean;
}

/** `columns` row (0001). */
export interface SchemaColumn {
    id: UUID;
    schema_object_id: UUID;
    column_name: string;
    data_type: string;
    nullable: boolean;
    is_pk: boolean;
    ordinal_position: number;
    created_at: IsoDateString;
}

// ---------------------------------------------------------------------------
// RAG notes (migration 0007)
// ---------------------------------------------------------------------------

/**
 * `rag_notes` row (0007). Free-form notes indexed alongside schema metadata
 * to ground SQL generation.
 */
export interface RagNote {
    id: UUID;
    data_source_id: UUID;
    title: string;
    content: string;
    active: boolean;
    created_by: string | null;
    updated_by: string | null;
    created_at: IsoDateString;
    updated_at: IsoDateString;
}

// ---------------------------------------------------------------------------
// LLM providers + routing (migrations 0002, 0009, 0010)
// ---------------------------------------------------------------------------

/**
 * Built-in provider identifiers recognised across the codebase. Custom
 * providers (added in 0010) supply their own identifier alongside a
 * non-null `base_url`, so this union is intentionally non-exhaustive at
 * the storage layer — see `LlmProviderConfig.provider`.
 */
export type LlmProviderName = 'openai' | 'gemini' | 'deepseek' | 'openrouter';

/**
 * Authentication provider types supported by the system.
 * These correspond to the types allowed in the auth_providers table.
 */
export const AUTH_PROVIDER_TYPES = ['oidc', 'saml', 'ldap', 'ad', 'pd'] as const;
export type AuthProviderType = (typeof AUTH_PROVIDER_TYPES)[number];

export type ProviderConfig = Readonly<Record<string, unknown>>;

/**
 * `llm_providers` row.
 *
 * Sources of truth:
 *   - 0002_provider_and_job_tables.sql (initial shape)
 *   - 0009_add_openrouter_provider.sql (adds `openrouter` to built-ins)
 *   - 0010_custom_provider_support.sql (adds `base_url` + `display_name`;
 *     allows arbitrary `provider` strings when `base_url IS NOT NULL`).
 */
export interface LlmProviderConfig {
    id: UUID;
    /**
     * Either a built-in provider name (see `LlmProviderName`) or the
     * identifier of a custom provider (any non-empty string when
     * `base_url` is set, per 0010's CHECK constraint).
     */
    provider: LlmProviderName | string;
    api_key_ref: string;
    default_model: string;
    enabled: boolean;
    /** Added in 0010. NULL for built-in providers. */
    base_url: string | null;
    /** Added in 0010. Human-readable label shown in admin UIs. */
    display_name: string | null;
    created_at: IsoDateString;
    updated_at: IsoDateString;
}

export type RoutingStrategy =
    | 'ordered_fallback'
    | 'cost_optimized'
    | 'latency_optimized';

/**
 * `llm_routing_rules` row.
 *
 * Sources of truth:
 *   - 0002_provider_and_job_tables.sql (initial shape)
 *   - 0009_add_openrouter_provider.sql (adds `openrouter`)
 *   - 0010_custom_provider_support.sql (drops the built-in-only CHECK on
 *     `primary_provider`; now any non-empty trimmed string is allowed so
 *     custom providers can be routed to).
 */
export interface RoutingRule {
    id: UUID;
    data_source_id: UUID;
    /** Built-in name or a custom provider identifier (see 0010). */
    primary_provider: LlmProviderName | string;
    fallback_providers: string[];
    strategy: RoutingStrategy;
    created_at: IsoDateString;
    updated_at: IsoDateString;
}

// ---------------------------------------------------------------------------
// Query lifecycle (migration 0001) — request, run, attempt
// ---------------------------------------------------------------------------

/**
 * `query_sessions` row (0001). Each user-initiated NL question lives in a
 * session; one or more `QueryRun` (a.k.a. attempt) rows hang off it.
 *
 * Re-exported as `QueryRequest` from `./index.ts` to match the canonical
 * name used in TS-004's ticket; both refer to this same table.
 */
export interface QueryRequest {
    id: UUID;
    user_id: string;
    data_source_id: UUID;
    question: string;
    /** Default `'created'`. Free-form lifecycle string. */
    status: string;
    created_at: IsoDateString;
}

/** Shape of the JSONB validator payload persisted on each query attempt. */
export interface QueryAttemptValidationResult {
    ok: boolean;
    issues?: Array<{ code: string; message: string; severity?: string }>;
    [key: string]: unknown;
}

/** Token-usage breakdown JSONB blob persisted with each attempt. */
export interface QueryAttemptTokenUsage {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
    [key: string]: unknown;
}

/**
 * `query_attempts` row (0001). The repo calls one of these a "query run";
 * `QueryRun` is the canonical TS-004 name.
 */
export interface QueryRun {
    id: UUID;
    session_id: UUID;
    llm_provider: string;
    model: string;
    prompt_version: string;
    generated_sql: string;
    validation_result_json: QueryAttemptValidationResult;
    latency_ms: number;
    token_usage_json: QueryAttemptTokenUsage | null;
    created_at: IsoDateString;
}

// ---------------------------------------------------------------------------
// Saved queries + folders + schedules (migrations 0011–0013, 0024–0027)
// ---------------------------------------------------------------------------

/** AUTH-006 / QUERY-006 visibility for saved queries (0024). */
export type SavedQueryVisibility = 'private' | 'shared';

/**
 * Declared parameter on a saved query (JSONB element in
 * `saved_queries.parameter_schema`).
 *
 * The shape is enforced by the service layer in
 * `app/src/services/savedQueriesService.js` and mirrors the OpenAPI
 * `QueryParameter` schema. Keep this type in sync if either side moves.
 */
export interface SavedQueryParameter {
    name: string;
    type: 'string' | 'number' | 'boolean' | 'date';
    required?: boolean;
    default?: string | number | boolean | null;
    description?: string | null;
    /** Optional whitelist of allowed values. */
    enum?: Array<string | number>;
}

/**
 * `saved_queries` row.
 *
 * Sources of truth:
 *   - 0011_saved_queries.sql (initial shape)
 *   - 0012_saved_query_parameters.sql (`parameter_schema`)
 *   - 0013_saved_query_tags.sql (`tags`)
 *   - 0024_saved_query_sharing.sql (`visibility`)
 *   - 0026_saved_query_folders.sql (`folder_id`)
 */
export interface SavedQuery {
    id: UUID;
    owner_id: string;
    name: string;
    description: string | null;
    data_source_id: UUID;
    sql: string;
    /** Default `{}`. Parameter values applied when no override is supplied. */
    default_run_params: Record<string, unknown>;
    created_at: IsoDateString;
    updated_at: IsoDateString;
    /** Added in 0012. Default `[]`. */
    parameter_schema: SavedQueryParameter[];
    /** Added in 0013. Default `{}`. */
    tags: string[];
    /** Added in 0024. Default `'private'`. */
    visibility: SavedQueryVisibility;
    /** Added in 0026. NULL means the query lives at the owner's root. */
    folder_id: UUID | null;
}

/**
 * `saved_query_folders` row (0026). `parent_id` is NULL when the folder
 * lives at the owner's root.
 */
export interface SavedQueryFolder {
    id: UUID;
    owner_id: string;
    parent_id: UUID | null;
    name: string;
    created_at: IsoDateString;
    updated_at: IsoDateString;
}

export type SavedQueryScheduleDeliveryMode = 'email' | 'download_artifact';
export type SavedQueryScheduleFormat = 'json' | 'csv' | 'tsv' | 'xlsx' | 'parquet';
export type SavedQueryScheduleStatus = 'active' | 'paused';
export type SavedQueryScheduleRunStatus =
    | 'pending'
    | 'running'
    | 'succeeded'
    | 'failed';

/**
 * `saved_query_schedules` row (0027). Cron-driven recurring delivery of a
 * saved query to email (or a download artifact).
 */
export interface SavedQuerySchedule {
    id: UUID;
    saved_query_id: UUID;
    owner_user_id: UUID | null;
    name: string;
    cron_expression: string;
    timezone: string;
    recipients: string[];
    delivery_mode: SavedQueryScheduleDeliveryMode;
    format: SavedQueryScheduleFormat;
    /** Default `{}`. Overrides for the saved query's `default_run_params`. */
    parameter_overrides: Record<string, unknown>;
    status: SavedQueryScheduleStatus;
    next_run_at: IsoDateString | null;
    last_run_at: IsoDateString | null;
    last_status: SavedQueryScheduleRunStatus | null;
    created_at: IsoDateString;
    updated_at: IsoDateString;
}

/** `saved_query_schedule_runs` row (0027). Append-only delivery history. */
export interface SavedQueryScheduleRun {
    id: UUID;
    schedule_id: UUID;
    saved_query_id: UUID;
    scheduled_for: IsoDateString;
    started_at: IsoDateString | null;
    completed_at: IsoDateString | null;
    status: SavedQueryScheduleRunStatus;
    attempt: number;
    recipients: string[];
    delivery_mode: SavedQueryScheduleDeliveryMode;
    format: SavedQueryScheduleFormat;
    file_name: string | null;
    file_size_bytes: number | null;
    row_count: number | null;
    error_message: string | null;
}

// ---------------------------------------------------------------------------
// Users + sessions + auth audit (migrations 0014, 0015, 0018)
// ---------------------------------------------------------------------------

/**
 * `users` row (0014). `password_hash` is NULL for SSO-only accounts created
 * via JIT provisioning (0019).
 */
export interface User {
    id: UUID;
    email: string;
    password_hash: string | null;
    display_name: string | null;
    is_active: boolean;
    last_login_at: IsoDateString | null;
    created_at: IsoDateString;
    updated_at: IsoDateString;
}

/**
 * `user_sessions` row (0014). One per active server-side session token.
 * `Session` is exported under that friendlier name from `./index.ts`.
 */
export interface Session {
    id: UUID;
    user_id: UUID;
    token_hash: string;
    user_agent: string | null;
    ip_address: string | null;
    created_at: IsoDateString;
    expires_at: IsoDateString;
    last_seen_at: IsoDateString;
    revoked_at: IsoDateString | null;
}

export type AuditEventOutcome = 'success' | 'failure' | 'info';

/**
 * `auth_audit_log` row.
 *
 * Sources of truth:
 *   - 0015_auth_roles_and_permissions.sql (initial shape — `id`, actor /
 *     target, `action`, `details`, `created_at`).
 *   - 0018_auth_audit_trail.sql (`outcome`, `ip_address`, `user_agent`,
 *     `actor_email`).
 *
 * `AuditEvent` is the friendlier name re-exported from `./index.ts`; the
 * underlying table is `auth_audit_log` but it covers more than auth events
 * since 0018.
 */
export interface AuditEvent {
    id: UUID;
    actor_user_id: UUID | null;
    target_user_id: UUID | null;
    action: string;
    /** Default `{}`. Free-form per-action metadata. */
    details: Record<string, unknown>;
    created_at: IsoDateString;
    /** Added in 0018. Nullable because pre-0018 rows have no value. */
    outcome: AuditEventOutcome | null;
    /** Added in 0018. */
    ip_address: string | null;
    /** Added in 0018. */
    user_agent: string | null;
    /** Added in 0018. Captured when no `actor_user_id` exists (e.g. failed login for unknown email). */
    actor_email: string | null;
}
