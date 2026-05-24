import appDb = require("../lib/appDb");
import * as versionService from "./savedQueryVersionService";
import type { SavedQuerySnapshot, SavedQueryVersionRow } from "./savedQueryVersionService";
import {
  SAVED_QUERY_NAME_MAX_LENGTH,
  SAVED_QUERY_DESCRIPTION_MAX_LENGTH,
  SAVED_QUERY_TAG_MAX_LENGTH,
  SAVED_QUERY_MAX_TAGS
} from "../lib/constants";
import {
  clamp,
  isUuid,
  isPgUniqueViolation,
  normalizeOptionalTrimmedString,
  validateSavedQueryDefaultRunParams,
  type SavedQueryDefaultRunParams
} from "../lib/validation";
import { createDatabaseAdapter, isSupportedDbType } from "../adapters/dbAdapterFactory";
import { validateAndNormalizeSql, sanitizeGeneratedSql, ensureLimit } from "./sqlSafety";
import {
  extractPlaceholders,
  buildParameterSchemaFromPlaceholders,
  type ParameterSchemaEntry
} from "./queryParameterParser";
import {
  validateParameterSchema,
  validateParameterValues,
  substitutePlaceholdersForValidation
} from "./queryParameterService";
import type { SavedQueryVisibility } from "../types/domain";

export interface ServiceSuccess<T> {
  ok: true;
  statusCode: number;
  body: T;
}
export interface ServiceFailure<T = unknown> {
  ok: false;
  statusCode: number;
  body: T;
}
export type ServiceResult<TSuccess, TFailure = unknown> =
  | ServiceSuccess<TSuccess>
  | ServiceFailure<TFailure>;

interface ErrorBody {
  error: string;
  message?: string;
  errors?: unknown;
}

function success<T>(body: T, statusCode = 200): ServiceSuccess<T> {
  return { ok: true, statusCode, body };
}

function failure<T>(statusCode: number, body: T): ServiceFailure<T> {
  return { ok: false, statusCode, body };
}

const SAVED_QUERY_COLUMNS = `
  id,
  owner_id,
  name,
  description,
  data_source_id,
  sql,
  default_run_params,
  parameter_schema,
  tags,
  visibility,
  folder_id,
  created_at,
  updated_at
`;

const ALLOWED_VISIBILITY: ReadonlySet<SavedQueryVisibility> = new Set<SavedQueryVisibility>(["private", "shared"]);
export type SharePermission = "view" | "run";
const ALLOWED_SHARE_PERMISSIONS: ReadonlySet<SharePermission> = new Set<SharePermission>(["view", "run"]);

export interface SavedQueryRow {
  id: string;
  owner_id: string;
  name: string;
  description: string | null;
  data_source_id: string;
  sql: string;
  default_run_params: Record<string, unknown>;
  parameter_schema: ParameterSchemaEntry[];
  tags: string[];
  visibility: SavedQueryVisibility;
  folder_id: string | null;
  created_at: string | Date;
  updated_at: string | Date;
}

interface ExecutableSavedQueryRow extends Omit<SavedQueryRow, "folder_id"> {
  connection_ref: string;
  db_type: string;
}

interface SchemaObjectMinimal {
  schema_name: string;
  object_name: string;
}

interface ShareRow {
  saved_query_id: string;
  user_id: string;
  permission: SharePermission;
  granted_by_user_id: string | null;
  created_at: string | Date;
}

interface ShareGrant {
  user_id: string;
  permission: SharePermission;
}

type Validation<T> = { ok: true; value: T } | { ok: false; message: string };

function normalizeTags(value: unknown): Validation<string[]> {
  if (value === undefined || value === null) {
    return { ok: true, value: [] };
  }
  if (!Array.isArray(value)) {
    return { ok: false, message: "tags must be an array of strings" };
  }

  const seen = new Set<string>();
  const tags: string[] = [];
  for (const entry of value) {
    if (typeof entry !== "string") {
      return { ok: false, message: "tags must be an array of strings" };
    }
    const trimmed = entry.trim().toLowerCase();
    if (!trimmed) {
      continue;
    }
    if (trimmed.length > SAVED_QUERY_TAG_MAX_LENGTH) {
      return {
        ok: false,
        message: `tag '${trimmed}' exceeds ${SAVED_QUERY_TAG_MAX_LENGTH} characters`
      };
    }
    if (seen.has(trimmed)) {
      continue;
    }
    seen.add(trimmed);
    tags.push(trimmed);
  }

  if (tags.length > SAVED_QUERY_MAX_TAGS) {
    return { ok: false, message: `cannot exceed ${SAVED_QUERY_MAX_TAGS} tags per query` };
  }

  return { ok: true, value: tags };
}

async function ensureDataSourceExists(dataSourceId: string): Promise<boolean> {
  const sourceResult = await appDb.query("SELECT id FROM data_sources WHERE id = $1", [dataSourceId]);
  return (sourceResult.rowCount ?? 0) > 0;
}

async function loadSavedQuery(savedQueryId: string): Promise<SavedQueryRow | null> {
  const result = await appDb.query<SavedQueryRow>(
    `SELECT ${SAVED_QUERY_COLUMNS} FROM saved_queries WHERE id = $1`,
    [savedQueryId]
  );
  return result.rows[0] || null;
}

async function loadSavedQueryForExecution(savedQueryId: string): Promise<ExecutableSavedQueryRow | null> {
  const result = await appDb.query<ExecutableSavedQueryRow>(
    `
      SELECT
        sq.id,
        sq.owner_id,
        sq.name,
        sq.description,
        sq.data_source_id,
        sq.sql,
        sq.default_run_params,
        sq.parameter_schema,
        sq.tags,
        sq.visibility,
        sq.created_at,
        sq.updated_at,
        ds.connection_ref,
        ds.db_type
      FROM saved_queries sq
      JOIN data_sources ds ON ds.id = sq.data_source_id
      WHERE sq.id = $1
    `,
    [savedQueryId]
  );

  return result.rows[0] || null;
}

async function loadSchemaObjects(dataSourceId: string): Promise<SchemaObjectMinimal[]> {
  const result = await appDb.query<SchemaObjectMinimal>(
    `
      SELECT schema_name, object_name
      FROM schema_objects
      WHERE data_source_id = $1
        AND is_ignored = FALSE
        AND object_type IN ('table', 'view', 'materialized_view')
    `,
    [dataSourceId]
  );
  return result.rows;
}

function resolveParameterSchema(
  sql: string,
  providedParameterSchema: unknown,
  existingSchema: ParameterSchemaEntry[] | unknown[]
): Validation<ParameterSchemaEntry[]> {
  const placeholders = extractPlaceholders(sql);

  if (providedParameterSchema === undefined) {
    return {
      ok: true,
      value: buildParameterSchemaFromPlaceholders(placeholders, existingSchema)
    };
  }

  const schemaValidation = validateParameterSchema(providedParameterSchema);
  if (!schemaValidation.ok) {
    return schemaValidation;
  }

  return {
    ok: true,
    value: buildParameterSchemaFromPlaceholders(placeholders, schemaValidation.value)
  };
}

interface ResolvedRunOptions {
  maxRows: number;
  timeoutMs: number;
}

function resolveRunOptions(defaultRunParams: SavedQueryDefaultRunParams | Record<string, unknown> | null | undefined, requested?: { maxRows?: unknown; timeoutMs?: unknown }): ResolvedRunOptions {
  const params = (defaultRunParams || {}) as Record<string, unknown>;
  const merged: { max_rows?: unknown; timeout_ms?: unknown } = {
    max_rows: params.max_rows,
    timeout_ms: params.timeout_ms
  };

  if (requested && Object.prototype.hasOwnProperty.call(requested, "maxRows") && requested.maxRows !== undefined) {
    merged.max_rows = requested.maxRows;
  }
  if (requested && Object.prototype.hasOwnProperty.call(requested, "timeoutMs") && requested.timeoutMs !== undefined) {
    merged.timeout_ms = requested.timeoutMs;
  }

  const maxRows = Number(merged.max_rows);
  const timeoutMs = Number(merged.timeout_ms);

  return {
    maxRows: clamp(Number.isFinite(maxRows) ? maxRows : 1000, 1, 100000),
    timeoutMs: clamp(Number.isFinite(timeoutMs) ? timeoutMs : 20000, 1000, 120000)
  };
}

export interface CallerOptions {
  callerUserId?: string | null;
}

export async function getSavedQuery(savedQueryId: string, { callerUserId }: CallerOptions = {}): Promise<ServiceResult<SavedQueryRow, ErrorBody>> {
  if (!isUuid(savedQueryId)) {
    return failure(400, { error: "bad_request", message: "savedQueryId must be a valid UUID" });
  }
  const savedQuery = await loadSavedQuery(savedQueryId);
  if (!savedQuery) {
    return failure(404, { error: "not_found", message: "Saved query not found" });
  }
  if (callerUserId) {
    const access = await resolveCallerAccess(savedQuery, callerUserId);
    if (!access) {
      return failure(403, { error: "forbidden", message: "You do not have access to this saved query" });
    }
  }
  return success(savedQuery);
}

export interface ListSavedQueriesResult {
  items: SavedQueryRow[];
}

export async function listSavedQueries(dataSourceId: unknown, tag: unknown, { callerUserId }: CallerOptions = {}): Promise<ServiceResult<ListSavedQueriesResult, ErrorBody>> {
  const filter = typeof dataSourceId === "string" ? dataSourceId.trim() : "";
  if (filter && !isUuid(filter)) {
    return failure(400, { error: "bad_request", message: "data_source_id must be a valid UUID" });
  }

  const tagFilter = typeof tag === "string" ? tag.trim().toLowerCase() : "";
  if (tagFilter && tagFilter.length > SAVED_QUERY_TAG_MAX_LENGTH) {
    return failure(400, {
      error: "bad_request",
      message: `tag exceeds ${SAVED_QUERY_TAG_MAX_LENGTH} characters`
    });
  }

  // When a caller is supplied, restrict to:
  //   - queries the caller owns
  //   - queries with visibility = 'shared'
  //   - queries with an explicit share row for the caller
  // The data-source-access filter still runs in the route layer so an admin
  // doesn't suddenly leak queries from sources they were never granted.
  if (callerUserId) {
    const result = await appDb.query<SavedQueryRow>(
      `
        SELECT ${SAVED_QUERY_COLUMNS}
        FROM saved_queries sq
        WHERE ($1::uuid IS NULL OR sq.data_source_id = $1::uuid)
          AND ($2::text IS NULL OR $2::text = ANY(sq.tags))
          AND (
            sq.owner_id = $3
            OR sq.visibility = 'shared'
            OR EXISTS (
              SELECT 1 FROM saved_query_shares s
              WHERE s.saved_query_id = sq.id AND s.user_id = $3
            )
          )
        ORDER BY sq.updated_at DESC, sq.created_at DESC
      `,
      [filter || null, tagFilter || null, callerUserId]
    );
    return success({ items: result.rows });
  }

  const result = await appDb.query<SavedQueryRow>(
    `
      SELECT ${SAVED_QUERY_COLUMNS}
      FROM saved_queries
      WHERE ($1::uuid IS NULL OR data_source_id = $1::uuid)
        AND ($2::text IS NULL OR $2::text = ANY(tags))
      ORDER BY updated_at DESC, created_at DESC
    `,
    [filter || null, tagFilter || null]
  );

  return success({ items: result.rows });
}

function normalizeVisibility(value: unknown, fallback: SavedQueryVisibility = "private"): Validation<SavedQueryVisibility> {
  if (value === undefined) return { ok: true, value: fallback };
  if (typeof value !== "string" || !ALLOWED_VISIBILITY.has(value as SavedQueryVisibility)) {
    return { ok: false, message: `visibility must be one of: ${[...ALLOWED_VISIBILITY].join(", ")}` };
  }
  return { ok: true, value: value as SavedQueryVisibility };
}

export interface CreateSavedQueryInput {
  ownerId?: string | null;
  name?: unknown;
  description?: unknown;
  dataSourceId?: unknown;
  sql?: unknown;
  defaultRunParams?: unknown;
  parameterSchema?: unknown;
  tags?: unknown;
  visibility?: unknown;
}

export async function createSavedQuery({
  ownerId,
  name,
  description,
  dataSourceId,
  sql,
  defaultRunParams,
  parameterSchema,
  tags,
  visibility
}: CreateSavedQueryInput): Promise<ServiceResult<SavedQueryRow, ErrorBody>> {
  const trimmedOwnerId = String(ownerId || "anonymous").trim() || "anonymous";
  const trimmedDataSourceId = String(dataSourceId || "").trim();
  const trimmedName = typeof name === "string" ? name.trim() : "";
  const trimmedSql = typeof sql === "string" ? sql.trim() : "";
  const normalizedDescription = normalizeOptionalTrimmedString(description);
  const defaultRunParamsValidation = validateSavedQueryDefaultRunParams(defaultRunParams);
  const parameterSchemaValidation = resolveParameterSchema(trimmedSql, parameterSchema, []);
  const tagsValidation = normalizeTags(tags);
  const visibilityValidation = normalizeVisibility(visibility);

  if (!trimmedName || !trimmedDataSourceId || !trimmedSql) {
    return failure(400, { error: "bad_request", message: "name, data_source_id and sql are required" });
  }
  if (!isUuid(trimmedDataSourceId)) {
    return failure(400, { error: "bad_request", message: "data_source_id must be a valid UUID" });
  }
  if (trimmedName.length > SAVED_QUERY_NAME_MAX_LENGTH) {
    return failure(400, {
      error: "bad_request",
      message: `name cannot exceed ${SAVED_QUERY_NAME_MAX_LENGTH} characters`
    });
  }
  if (normalizedDescription && normalizedDescription.length > SAVED_QUERY_DESCRIPTION_MAX_LENGTH) {
    return failure(400, {
      error: "bad_request",
      message: `description cannot exceed ${SAVED_QUERY_DESCRIPTION_MAX_LENGTH} characters`
    });
  }
  if (defaultRunParamsValidation.ok !== true) {
    return failure(400, { error: "bad_request", message: defaultRunParamsValidation.message });
  }
  if (parameterSchemaValidation.ok !== true) {
    return failure(400, { error: "bad_request", message: parameterSchemaValidation.message });
  }
  if (tagsValidation.ok !== true) {
    return failure(400, { error: "bad_request", message: tagsValidation.message });
  }
  if (visibilityValidation.ok !== true) {
    return failure(400, { error: "bad_request", message: visibilityValidation.message });
  }

  if (!(await ensureDataSourceExists(trimmedDataSourceId))) {
    return failure(404, { error: "not_found", message: "Data source not found" });
  }

  try {
    const insertResult = await appDb.query<SavedQueryRow>(
      `
        INSERT INTO saved_queries (
          owner_id,
          name,
          description,
          data_source_id,
          sql,
          default_run_params,
          parameter_schema,
          tags,
          visibility
        ) VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb, $8::text[], $9)
        RETURNING ${SAVED_QUERY_COLUMNS}
      `,
      [
        trimmedOwnerId,
        trimmedName,
        normalizedDescription,
        trimmedDataSourceId,
        trimmedSql,
        JSON.stringify(defaultRunParamsValidation.value),
        JSON.stringify(parameterSchemaValidation.value),
        tagsValidation.value,
        visibilityValidation.value
      ]
    );

    const created = insertResult.rows[0];
    await versionService.recordVersion(
      created.id,
      versionService.snapshotFromSavedQuery(created) as SavedQuerySnapshot,
      { actorUserId: isUuid(trimmedOwnerId) ? trimmedOwnerId : null, changeSummary: "created" }
    );
    return success(created, 201);
  } catch (err) {
    if (isPgUniqueViolation(err)) {
      return failure(409, {
        error: "conflict",
        message: "Saved query name already exists for this owner and data source"
      });
    }
    throw err;
  }
}

export interface UpdateSavedQueryInput extends CreateSavedQueryInput {
  callerUserId?: string | null;
}

export async function updateSavedQuery(savedQueryId: string, {
  name,
  description,
  dataSourceId,
  sql,
  defaultRunParams,
  parameterSchema,
  tags,
  visibility,
  callerUserId
}: UpdateSavedQueryInput): Promise<ServiceResult<SavedQueryRow, ErrorBody>> {
  if (!isUuid(savedQueryId)) {
    return failure(400, { error: "bad_request", message: "savedQueryId must be a valid UUID" });
  }

  const existing = await loadSavedQuery(savedQueryId);
  if (!existing) {
    return failure(404, { error: "not_found", message: "Saved query not found" });
  }
  if (callerUserId && existing.owner_id !== callerUserId) {
    return failure(403, { error: "forbidden", message: "Only the owner can update this saved query" });
  }

  const trimmedDataSourceId = String(dataSourceId || "").trim();
  const trimmedName = typeof name === "string" ? name.trim() : "";
  const trimmedSql = typeof sql === "string" ? sql.trim() : "";
  const normalizedDescription = normalizeOptionalTrimmedString(description);
  const defaultRunParamsValidation = validateSavedQueryDefaultRunParams(defaultRunParams);
  const parameterSchemaValidation = resolveParameterSchema(trimmedSql, parameterSchema, existing.parameter_schema);
  const tagsValidation: Validation<string[]> = tags === undefined
    ? { ok: true, value: existing.tags || [] }
    : normalizeTags(tags);
  const visibilityValidation = normalizeVisibility(visibility, existing.visibility || "private");

  if (!trimmedName || !trimmedDataSourceId || !trimmedSql) {
    return failure(400, { error: "bad_request", message: "name, data_source_id and sql are required" });
  }
  if (!isUuid(trimmedDataSourceId)) {
    return failure(400, { error: "bad_request", message: "data_source_id must be a valid UUID" });
  }
  if (trimmedName.length > SAVED_QUERY_NAME_MAX_LENGTH) {
    return failure(400, {
      error: "bad_request",
      message: `name cannot exceed ${SAVED_QUERY_NAME_MAX_LENGTH} characters`
    });
  }
  if (normalizedDescription && normalizedDescription.length > SAVED_QUERY_DESCRIPTION_MAX_LENGTH) {
    return failure(400, {
      error: "bad_request",
      message: `description cannot exceed ${SAVED_QUERY_DESCRIPTION_MAX_LENGTH} characters`
    });
  }
  if (defaultRunParamsValidation.ok !== true) {
    return failure(400, { error: "bad_request", message: defaultRunParamsValidation.message });
  }
  if (parameterSchemaValidation.ok !== true) {
    return failure(400, { error: "bad_request", message: parameterSchemaValidation.message });
  }
  if (tagsValidation.ok !== true) {
    return failure(400, { error: "bad_request", message: tagsValidation.message });
  }
  if (visibilityValidation.ok !== true) {
    return failure(400, { error: "bad_request", message: visibilityValidation.message });
  }

  if (!(await ensureDataSourceExists(trimmedDataSourceId))) {
    return failure(404, { error: "not_found", message: "Data source not found" });
  }

  try {
    const updateResult = await appDb.query<SavedQueryRow>(
      `
        UPDATE saved_queries
        SET
          name = $2,
          description = $3,
          data_source_id = $4,
          sql = $5,
          default_run_params = $6::jsonb,
          parameter_schema = $7::jsonb,
          tags = $8::text[],
          visibility = $9,
          updated_at = NOW()
        WHERE id = $1
        RETURNING ${SAVED_QUERY_COLUMNS}
      `,
      [
        savedQueryId,
        trimmedName,
        normalizedDescription,
        trimmedDataSourceId,
        trimmedSql,
        JSON.stringify(defaultRunParamsValidation.value),
        JSON.stringify(parameterSchemaValidation.value),
        tagsValidation.value,
        visibilityValidation.value
      ]
    );

    const updated = updateResult.rows[0];
    await versionService.recordVersion(
      updated.id,
      versionService.snapshotFromSavedQuery(updated) as SavedQuerySnapshot,
      { actorUserId: callerUserId || null, changeSummary: "updated" }
    );
    return success(updated);
  } catch (err) {
    if (isPgUniqueViolation(err)) {
      return failure(409, {
        error: "conflict",
        message: "Saved query name already exists for this owner and data source"
      });
    }
    throw err;
  }
}

export async function deleteSavedQuery(savedQueryId: string, { callerUserId }: CallerOptions = {}): Promise<ServiceResult<{ ok: true; id: string }, ErrorBody>> {
  if (!isUuid(savedQueryId)) {
    return failure(400, { error: "bad_request", message: "savedQueryId must be a valid UUID" });
  }

  if (callerUserId) {
    const existing = await loadSavedQuery(savedQueryId);
    if (!existing) {
      return failure(404, { error: "not_found", message: "Saved query not found" });
    }
    if (existing.owner_id !== callerUserId) {
      return failure(403, { error: "forbidden", message: "Only the owner can delete this saved query" });
    }
  }

  const deleteResult = await appDb.query<{ id: string }>(
    `DELETE FROM saved_queries WHERE id = $1 RETURNING id`,
    [savedQueryId]
  );

  if (deleteResult.rowCount === 0) {
    return failure(404, { error: "not_found", message: "Saved query not found" });
  }

  return success({ ok: true as const, id: deleteResult.rows[0].id });
}

async function loadShareRecord(savedQueryId: string, userId: string): Promise<{ permission: SharePermission } | null> {
  if (!isUuid(savedQueryId) || !userId) return null;
  const result = await appDb.query<{ permission: SharePermission }>(
    `SELECT permission FROM saved_query_shares WHERE saved_query_id = $1 AND user_id = $2`,
    [savedQueryId, userId]
  );
  return result.rows[0] || null;
}

export type CallerAccess = "owner" | SharePermission | null;

// Effective access for the caller. Owner is always full. Visibility 'shared'
// gives view; explicit share row gives view-or-run. Returns one of:
// 'owner' | 'run' | 'view' | null
export async function resolveCallerAccess(savedQuery: Pick<SavedQueryRow, "id" | "owner_id" | "visibility"> | null, callerUserId: string | null | undefined): Promise<CallerAccess> {
  if (!savedQuery) return null;
  if (!callerUserId) return null;
  if (savedQuery.owner_id === callerUserId) return "owner";
  const share = await loadShareRecord(savedQuery.id, callerUserId);
  if (share) return share.permission;
  if (savedQuery.visibility === "shared") return "view";
  return null;
}

interface ValidateParamsBody {
  ok: boolean;
  errors?: unknown[];
  resolved_values?: Record<string, unknown>;
}

export async function validateSavedQueryParams(savedQueryId: string, providedParams: unknown, { callerUserId }: CallerOptions = {}): Promise<ServiceResult<ValidateParamsBody, ErrorBody>> {
  if (!isUuid(savedQueryId)) {
    return failure(400, { error: "bad_request", message: "savedQueryId must be a valid UUID" });
  }

  const savedQuery = await loadSavedQuery(savedQueryId);
  if (!savedQuery) {
    return failure(404, { error: "not_found", message: "Saved query not found" });
  }
  if (callerUserId) {
    const access = await resolveCallerAccess(savedQuery, callerUserId);
    if (!access) {
      return failure(403, { error: "forbidden", message: "You do not have access to this saved query" });
    }
  }

  const validation = validateParameterValues(savedQuery.parameter_schema, providedParams);
  if (validation.ok !== true) {
    return success({ ok: false, errors: validation.errors });
  }

  return success({ ok: true, resolved_values: validation.resolvedValues });
}

export interface ExecuteSavedQueryInput {
  params?: unknown;
  maxRows?: unknown;
  timeoutMs?: unknown;
  callerUserId?: string | null;
}

export interface ExecuteSavedQueryResult {
  sql: string;
  columns: string[];
  rows: Record<string, unknown>[];
  row_count: number;
  duration_ms: number;
}

export async function executeSavedQuery(savedQueryId: string, { params, maxRows, timeoutMs, callerUserId }: ExecuteSavedQueryInput = {}): Promise<ServiceResult<ExecuteSavedQueryResult, ErrorBody>> {
  if (!isUuid(savedQueryId)) {
    return failure(400, { error: "bad_request", message: "savedQueryId must be a valid UUID" });
  }

  const savedQuery = await loadSavedQueryForExecution(savedQueryId);
  if (!savedQuery) {
    return failure(404, { error: "not_found", message: "Saved query not found" });
  }
  if (callerUserId) {
    const access = await resolveCallerAccess(
      { id: savedQuery.id, owner_id: savedQuery.owner_id, visibility: savedQuery.visibility },
      callerUserId
    );
    if (!access || access === "view") {
      return failure(403, {
        error: "forbidden",
        message: access === "view"
          ? "You can view this saved query but not run it"
          : "You do not have access to this saved query"
      });
    }
  }
  if (!isSupportedDbType(savedQuery.db_type)) {
    return failure(400, {
      error: "bad_request",
      message: `Unsupported db_type for execution: ${savedQuery.db_type}`
    });
  }

  const parameterValidation = validateParameterValues(savedQuery.parameter_schema, params);
  if (parameterValidation.ok !== true) {
    return failure(400, {
      error: "bad_request",
      message: "Invalid saved query parameters",
      errors: parameterValidation.errors
    });
  }

  const dialect = savedQuery.db_type === "mssql" ? "mssql" : "postgres";
  const { maxRows: resolvedMaxRows, timeoutMs: resolvedTimeoutMs } = resolveRunOptions(
    savedQuery.default_run_params,
    { maxRows, timeoutMs }
  );
  const executableSql = ensureLimit(sanitizeGeneratedSql(savedQuery.sql), resolvedMaxRows, dialect);
  const schemaObjects = await loadSchemaObjects(savedQuery.data_source_id);
  const validationSql = substitutePlaceholdersForValidation(executableSql, savedQuery.parameter_schema);
  const normalized = validateAndNormalizeSql(validationSql, {
    maxRows: resolvedMaxRows,
    schemaObjects,
    dialect
  });

  if (!normalized.ok) {
    return failure(400, {
      error: "bad_request",
      message: normalized.errors.join("; "),
      errors: normalized.errors
    });
  }

  let adapter: ReturnType<typeof createDatabaseAdapter> | null = null;
  try {
    adapter = createDatabaseAdapter(savedQuery.db_type, savedQuery.connection_ref);
    const adapterValidation = await adapter.validateSql(normalized.sql);
    if (!adapterValidation.ok) {
      return failure(400, {
        error: "bad_request",
        message: adapterValidation.errors.join("; "),
        errors: adapterValidation.errors
      });
    }

    const execution = await adapter.executeParameterizedReadOnly(
      executableSql,
      parameterValidation.resolvedValues,
      savedQuery.parameter_schema,
      { maxRows: resolvedMaxRows, timeoutMs: resolvedTimeoutMs }
    );

    return success({
      sql: executableSql,
      columns: execution.columns,
      rows: execution.rows,
      row_count: execution.rowCount,
      duration_ms: execution.durationMs
    });
  } finally {
    if (adapter) {
      await adapter.close();
    }
  }
}

async function listSharesForQuery(savedQueryId: string): Promise<ShareRow[]> {
  const result = await appDb.query<ShareRow>(
    `
      SELECT saved_query_id, user_id, permission, granted_by_user_id, created_at
      FROM saved_query_shares
      WHERE saved_query_id = $1
      ORDER BY created_at ASC
    `,
    [savedQueryId]
  );
  return result.rows;
}

function normalizeShareGrants(grants: unknown): Validation<ShareGrant[] | undefined> {
  if (grants === undefined) return { ok: true, value: undefined };
  if (!Array.isArray(grants)) {
    return { ok: false, message: "shares must be an array" };
  }
  const seen = new Set<string>();
  const normalized: ShareGrant[] = [];
  for (const entry of grants) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      return { ok: false, message: "each share entry must be an object" };
    }
    const record = entry as Record<string, unknown>;
    const userId = typeof record.user_id === "string" ? record.user_id.trim() : "";
    if (!isUuid(userId)) {
      return { ok: false, message: "each share entry must include a user_id UUID" };
    }
    if (seen.has(userId)) {
      return { ok: false, message: `duplicate share entry for user ${userId}` };
    }
    seen.add(userId);
    const permission = typeof record.permission === "string" ? record.permission : "";
    if (!ALLOWED_SHARE_PERMISSIONS.has(permission as SharePermission)) {
      return {
        ok: false,
        message: `permission must be one of: ${[...ALLOWED_SHARE_PERMISSIONS].join(", ")}`
      };
    }
    normalized.push({ user_id: userId, permission: permission as SharePermission });
  }
  return { ok: true, value: normalized };
}

export interface ShareSavedQueryInput {
  callerUserId?: string | null;
  visibility?: unknown;
  shares?: unknown;
}

export interface ShareSavedQueryResult {
  visibility: SavedQueryVisibility;
  previous_visibility: SavedQueryVisibility;
  shares: ShareRow[];
  diff: {
    added: ShareGrant[];
    updated: Array<ShareGrant & { previous_permission: SharePermission }>;
    removed: ShareGrant[];
  };
}

// Replace-semantics: the body's `shares` array fully replaces whatever
// rows exist for this query. Pass `shares: []` to revoke everyone.
// Visibility is optional and only changed when present in the body.
// Returns the new access summary plus a diff so callers can audit each change.
export async function shareSavedQuery(savedQueryId: string, { callerUserId, visibility, shares }: ShareSavedQueryInput = {}): Promise<ServiceResult<ShareSavedQueryResult, ErrorBody>> {
  if (!isUuid(savedQueryId)) {
    return failure(400, { error: "bad_request", message: "savedQueryId must be a valid UUID" });
  }
  if (!callerUserId) {
    return failure(401, { error: "unauthenticated" });
  }

  const existing = await loadSavedQuery(savedQueryId);
  if (!existing) {
    return failure(404, { error: "not_found", message: "Saved query not found" });
  }
  if (existing.owner_id !== callerUserId) {
    return failure(403, { error: "forbidden", message: "Only the owner can share this saved query" });
  }

  const visibilityValidation = visibility === undefined
    ? { ok: true as const, value: (existing.visibility || "private") as SavedQueryVisibility }
    : normalizeVisibility(visibility, existing.visibility || "private");
  if (visibilityValidation.ok !== true) {
    return failure(400, { error: "bad_request", message: visibilityValidation.message });
  }

  const sharesValidation = normalizeShareGrants(shares);
  if (sharesValidation.ok !== true) {
    return failure(400, { error: "bad_request", message: sharesValidation.message });
  }

  const previousVisibility = existing.visibility || "private";
  const previousShares = await listSharesForQuery(savedQueryId);
  const previousByUser = new Map<string, SharePermission>(previousShares.map((row) => [row.user_id, row.permission]));

  if (visibility !== undefined && visibilityValidation.value !== previousVisibility) {
    await appDb.query(
      `UPDATE saved_queries SET visibility = $2, updated_at = NOW() WHERE id = $1`,
      [savedQueryId, visibilityValidation.value]
    );
  }

  const added: ShareGrant[] = [];
  const updated: Array<ShareGrant & { previous_permission: SharePermission }> = [];
  const removed: ShareGrant[] = [];

  if (sharesValidation.value !== undefined) {
    const nextByUser = new Map<string, SharePermission>(sharesValidation.value.map((row) => [row.user_id, row.permission]));

    for (const [userId, permission] of nextByUser) {
      const prev = previousByUser.get(userId);
      if (!prev) {
        added.push({ user_id: userId, permission });
      } else if (prev !== permission) {
        updated.push({ user_id: userId, permission, previous_permission: prev });
      }
    }
    for (const [userId, permission] of previousByUser) {
      if (!nextByUser.has(userId)) {
        removed.push({ user_id: userId, permission });
      }
    }

    if (removed.length > 0) {
      await appDb.query(
        `DELETE FROM saved_query_shares WHERE saved_query_id = $1 AND user_id = ANY($2::uuid[])`,
        [savedQueryId, removed.map((entry) => entry.user_id)]
      );
    }
    for (const row of [...added, ...updated]) {
      await appDb.query(
        `
          INSERT INTO saved_query_shares (saved_query_id, user_id, permission, granted_by_user_id)
          VALUES ($1, $2, $3, $4)
          ON CONFLICT (saved_query_id, user_id)
            DO UPDATE SET permission = EXCLUDED.permission, granted_by_user_id = EXCLUDED.granted_by_user_id
        `,
        [savedQueryId, row.user_id, row.permission, callerUserId]
      );
    }
  }

  const finalShares = await listSharesForQuery(savedQueryId);
  return success({
    visibility: visibilityValidation.value,
    previous_visibility: previousVisibility,
    shares: finalShares,
    diff: { added, updated, removed }
  });
}

export interface SavedQueryAccessResult {
  saved_query_id: string;
  owner_id: string;
  visibility: SavedQueryVisibility;
  shares: ShareRow[];
}

export async function getSavedQueryAccess(savedQueryId: string, { callerUserId }: CallerOptions = {}): Promise<ServiceResult<SavedQueryAccessResult, ErrorBody>> {
  if (!isUuid(savedQueryId)) {
    return failure(400, { error: "bad_request", message: "savedQueryId must be a valid UUID" });
  }
  const savedQuery = await loadSavedQuery(savedQueryId);
  if (!savedQuery) {
    return failure(404, { error: "not_found", message: "Saved query not found" });
  }
  if (callerUserId) {
    const access = await resolveCallerAccess(savedQuery, callerUserId);
    if (!access) {
      return failure(403, { error: "forbidden", message: "You do not have access to this saved query" });
    }
  }
  const shares = await listSharesForQuery(savedQueryId);
  return success({
    saved_query_id: savedQueryId,
    owner_id: savedQuery.owner_id,
    visibility: savedQuery.visibility || "private",
    shares
  });
}

export async function listSavedQueryVersions(savedQueryId: string, { callerUserId }: CallerOptions = {}): Promise<ServiceResult<{ items: SavedQueryVersionRow[] }, ErrorBody>> {
  if (!isUuid(savedQueryId)) {
    return failure(400, { error: "bad_request", message: "savedQueryId must be a valid UUID" });
  }
  const savedQuery = await loadSavedQuery(savedQueryId);
  if (!savedQuery) {
    return failure(404, { error: "not_found", message: "Saved query not found" });
  }
  if (callerUserId) {
    const access = await resolveCallerAccess(savedQuery, callerUserId);
    if (!access) {
      return failure(403, { error: "forbidden", message: "You do not have access to this saved query" });
    }
  }
  const versions = await versionService.listVersions(savedQueryId);
  return success({ items: versions });
}

export interface RestoreVersionResult {
  saved_query: SavedQueryRow;
  restored_from_version_number: number;
  new_version: SavedQueryVersionRow;
}

export async function restoreSavedQueryVersion(savedQueryId: string, versionId: string, { callerUserId }: CallerOptions = {}): Promise<ServiceResult<RestoreVersionResult, ErrorBody>> {
  if (!isUuid(savedQueryId)) {
    return failure(400, { error: "bad_request", message: "savedQueryId must be a valid UUID" });
  }
  if (!isUuid(versionId)) {
    return failure(400, { error: "bad_request", message: "versionId must be a valid UUID" });
  }
  const existing = await loadSavedQuery(savedQueryId);
  if (!existing) {
    return failure(404, { error: "not_found", message: "Saved query not found" });
  }
  if (callerUserId && existing.owner_id !== callerUserId) {
    return failure(403, { error: "forbidden", message: "Only the owner can restore versions of this saved query" });
  }
  const version = await versionService.getVersionById(versionId);
  if (!version || version.saved_query_id !== savedQueryId) {
    return failure(404, { error: "not_found", message: "Version not found" });
  }

  // Apply the version's snapshot to the live row. We re-use the standard
  // UPDATE shape so visibility/tags/parameter_schema all flow through the
  // existing column list. The restore itself becomes a new version row so
  // the timeline reads top-to-bottom.
  const updateResult = await appDb.query<SavedQueryRow>(
    `
      UPDATE saved_queries
      SET
        name = $2,
        description = $3,
        data_source_id = $4,
        sql = $5,
        default_run_params = $6::jsonb,
        parameter_schema = $7::jsonb,
        tags = $8::text[],
        visibility = $9,
        updated_at = NOW()
      WHERE id = $1
      RETURNING ${SAVED_QUERY_COLUMNS}
    `,
    [
      savedQueryId,
      version.name,
      version.description,
      version.data_source_id,
      version.sql,
      JSON.stringify(version.default_run_params || {}),
      JSON.stringify(version.parameter_schema || []),
      version.tags || [],
      version.visibility || "private"
    ]
  );
  const restored = updateResult.rows[0];

  const newVersion = await versionService.recordVersion(
    savedQueryId,
    versionService.snapshotFromSavedQuery(restored) as SavedQuerySnapshot,
    {
      actorUserId: callerUserId || null,
      changeSummary: `restored from version ${version.version_number}`
    }
  );

  return success({
    saved_query: restored,
    restored_from_version_number: version.version_number,
    new_version: newVersion
  });
}
