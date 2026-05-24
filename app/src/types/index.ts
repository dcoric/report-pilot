/**
 * Central re-export hub for Report Pilot's TypeScript types.
 *
 * Two layers live in this folder:
 *
 *   1. `openapi.ts` — auto-generated from `docs/api/openapi.yaml` via
 *      `npm run types:openapi`. Do not edit by hand. Mirrors the structure
 *      the frontend already consumes from `frontend/src/lib/api/types.ts`.
 *
 *   2. `domain.ts` — hand-written shapes for DB rows and in-process configs
 *      that the OpenAPI spec does not describe (e.g. internal provider
 *      configuration, query lifecycle state).
 *
 * This index re-exports the most commonly used names from both so that
 * downstream code (once migrated to TypeScript) can simply do:
 *
 *     import type { SavedQuery, ApiPaths, AuthUser } from '../types';
 *
 * For schemas not pre-named below, drop down to the raw OpenAPI helpers:
 *
 *     import type { components } from '../types/openapi';
 *     type Foo = components['schemas']['Foo'];
 *
 * TS-004 is types-only — no runtime modules import these yet.
 */

import type { components, paths } from './openapi';

// ---------------------------------------------------------------------------
// OpenAPI primitives
// ---------------------------------------------------------------------------

/** Map of API path -> HTTP operation shapes. */
export type ApiPaths = paths;

/** Full `components` object from the generated OpenAPI types. */
export type ApiComponents = components;

/** Convenience: every named schema under `components.schemas`. */
export type ApiSchemas = components['schemas'];

/** Helper to look up an OpenAPI schema by name without writing `components['schemas']` every time. */
export type ApiSchema<K extends keyof ApiSchemas> = ApiSchemas[K];

// ---------------------------------------------------------------------------
// OpenAPI schemas re-exported under friendlier names.
//
// These are the schemas the route/service layer reaches for most often.
// For anything not listed, use `ApiSchema<'Name'>` or fall through to
// `components['schemas']['Name']` directly.
// ---------------------------------------------------------------------------

// Auth + admin
export type AuthUser = ApiSchema<'AuthUser'>;
export type AuthMeResponse = ApiSchema<'AuthMeResponse'>;
export type LoginRequest = ApiSchema<'LoginRequest'>;
export type LoginLockoutResponse = ApiSchema<'LoginLockoutResponse'>;
export type AdminUser = ApiSchema<'AdminUser'>;
export type CreateAdminUserRequest = ApiSchema<'CreateAdminUserRequest'>;
export type UpdateUserRolesRequest = ApiSchema<'UpdateUserRolesRequest'>;
export type AuthProvider = ApiSchema<'AuthProvider'>;
export type AuthProviderUpsertRequest = ApiSchema<'AuthProviderUpsertRequest'>;
export type AuthProviderMappingRulesRequest = ApiSchema<'AuthProviderMappingRulesRequest'>;
export type GrantDataSourceAccessRequest = ApiSchema<'GrantDataSourceAccessRequest'>;
export type LinkedIdentity = ApiSchema<'LinkedIdentity'>;
export type UserConfig = ApiSchema<'UserConfig'>;
export type PromptPreset = ApiSchema<'PromptPreset'>;
export type PromptPresetUpsertRequest = ApiSchema<'PromptPresetUpsertRequest'>;
export type AuditEventApi = ApiSchema<'AuditEvent'>;

// Data sources + schema
export type DataSourceResponse = ApiSchema<'DataSourceResponse'>;
export type CreateDataSourceRequest = ApiSchema<'CreateDataSourceRequest'>;
export type ImportSchemaRequest = ApiSchema<'ImportSchemaRequest'>;
export type SchemaObjectApi = ApiSchema<'SchemaObject'>;
export type SchemaObjectVisibilityRequest = ApiSchema<'SchemaObjectVisibilityRequest'>;
export type SemanticEntityRequest = ApiSchema<'SemanticEntityRequest'>;
export type MetricDefinitionRequest = ApiSchema<'MetricDefinitionRequest'>;
export type JoinPolicyRequest = ApiSchema<'JoinPolicyRequest'>;
export type RagNoteRequest = ApiSchema<'RagNoteRequest'>;
export type RagNoteResponse = ApiSchema<'RagNoteResponse'>;

// Providers + routing
export type LlmProviderRequest = ApiSchema<'LlmProviderRequest'>;
export type LlmProviderResponse = ApiSchema<'LlmProviderResponse'>;
export type RoutingRuleRequest = ApiSchema<'RoutingRuleRequest'>;
export type RoutingRuleResponse = ApiSchema<'RoutingRuleResponse'>;

// Saved queries + lifecycle
export type SavedQueryApi = ApiSchema<'SavedQuery'>;
export type CreateSavedQueryRequest = ApiSchema<'CreateSavedQueryRequest'>;
export type UpdateSavedQueryRequest = ApiSchema<'UpdateSavedQueryRequest'>;
export type ShareSavedQueryRequest = ApiSchema<'ShareSavedQueryRequest'>;
export type ValidateParamsRequest = ApiSchema<'ValidateParamsRequest'>;
export type RunSavedQueryRequest = ApiSchema<'RunSavedQueryRequest'>;
export type SavedQueryFolderApi = ApiSchema<'SavedQueryFolder'>;
export type CreateSavedQueryFolderRequest = ApiSchema<'CreateSavedQueryFolderRequest'>;
export type UpdateSavedQueryFolderRequest = ApiSchema<'UpdateSavedQueryFolderRequest'>;
export type MoveSavedQueryRequest = ApiSchema<'MoveSavedQueryRequest'>;
export type SavedQueryVersion = ApiSchema<'SavedQueryVersion'>;
export type SavedQueryScheduleApi = ApiSchema<'SavedQuerySchedule'>;
export type SavedQueryScheduleRequest = ApiSchema<'SavedQueryScheduleRequest'>;
export type SavedQueryScheduleRunApi = ApiSchema<'SavedQueryScheduleRun'>;
export type QueryParameter = ApiSchema<'QueryParameter'>;
export type CreateSessionRequest = ApiSchema<'CreateSessionRequest'>;
export type CreateSessionResponse = ApiSchema<'CreateSessionResponse'>;
export type RunSessionRequest = ApiSchema<'RunSessionRequest'>;
export type RunSessionResponse = ApiSchema<'RunSessionResponse'>;
export type FeedbackRequest = ApiSchema<'FeedbackRequest'>;

// Observability + benchmarks
export type BenchmarkReportUploadRequest = ApiSchema<'BenchmarkReportUploadRequest'>;

// Export delivery
export type ExportDeliveryStatus = ApiSchema<'ExportDeliveryStatus'>;
export type ExportRequest = ApiSchema<'ExportRequest'>;
export type ExportDeliverRequest = ApiSchema<'ExportDeliverRequest'>;

// ---------------------------------------------------------------------------
// Domain types (DB rows, provider configs).
// ---------------------------------------------------------------------------

export type {
    IsoDateString,
    UUID,
    DataSource,
    DataSourceDbType,
    SchemaObject,
    SchemaObjectType,
    SchemaColumn,
    RagNote,
    LlmProviderConfig,
    LlmProviderName,
    RoutingRule,
    RoutingStrategy,
    QueryRequest,
    QueryRun,
    QueryAttemptValidationResult,
    QueryAttemptTokenUsage,
    SavedQuery,
    SavedQueryVisibility,
    SavedQueryParameter,
    SavedQueryFolder,
    SavedQuerySchedule,
    SavedQueryScheduleDeliveryMode,
    SavedQueryScheduleFormat,
    SavedQueryScheduleStatus,
    SavedQueryScheduleRun,
    SavedQueryScheduleRunStatus,
    User,
    Session,
    AuditEvent,
    AuditEventOutcome,
} from './domain';
