const appDb = require("../lib/appDb");
const { SAVED_QUERY_NAME_MAX_LENGTH, SAVED_QUERY_DESCRIPTION_MAX_LENGTH } = require("../lib/constants");
const {
  clamp,
  isUuid,
  isPgUniqueViolation,
  normalizeOptionalTrimmedString,
  validateSavedQueryDefaultRunParams
} = require("../lib/validation");
const { createDatabaseAdapter, isSupportedDbType } = require("../adapters/dbAdapterFactory");
const { validateAndNormalizeSql, sanitizeGeneratedSql, ensureLimit } = require("./sqlSafety");
const {
  extractPlaceholders,
  buildParameterSchemaFromPlaceholders
} = require("./queryParameterParser");
const {
  validateParameterSchema,
  validateParameterValues,
  substitutePlaceholdersForValidation
} = require("./queryParameterService");

function success(body, statusCode = 200) {
  return { ok: true, statusCode, body };
}

function failure(statusCode, body) {
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
  created_at,
  updated_at
`;

async function ensureDataSourceExists(dataSourceId) {
  const sourceResult = await appDb.query("SELECT id FROM data_sources WHERE id = $1", [dataSourceId]);
  return sourceResult.rowCount > 0;
}

async function loadSavedQuery(savedQueryId) {
  const result = await appDb.query(
    `SELECT ${SAVED_QUERY_COLUMNS} FROM saved_queries WHERE id = $1`,
    [savedQueryId]
  );
  return result.rows[0] || null;
}

async function loadSavedQueryForExecution(savedQueryId) {
  const result = await appDb.query(
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

async function loadSchemaObjects(dataSourceId) {
  const result = await appDb.query(
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

function resolveParameterSchema(sql, providedParameterSchema, existingSchema) {
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

function resolveRunOptions(defaultRunParams, requested) {
  const merged = {
    max_rows: defaultRunParams?.max_rows,
    timeout_ms: defaultRunParams?.timeout_ms
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

async function getSavedQuery(savedQueryId) {
  if (!isUuid(savedQueryId)) {
    return failure(400, { error: "bad_request", message: "savedQueryId must be a valid UUID" });
  }
  const savedQuery = await loadSavedQuery(savedQueryId);
  if (!savedQuery) {
    return failure(404, { error: "not_found", message: "Saved query not found" });
  }
  return success(savedQuery);
}

async function listSavedQueries(dataSourceId) {
  const filter = typeof dataSourceId === "string" ? dataSourceId.trim() : "";
  if (filter && !isUuid(filter)) {
    return failure(400, { error: "bad_request", message: "data_source_id must be a valid UUID" });
  }

  const result = await appDb.query(
    `
      SELECT ${SAVED_QUERY_COLUMNS}
      FROM saved_queries
      WHERE ($1::uuid IS NULL OR data_source_id = $1::uuid)
      ORDER BY updated_at DESC, created_at DESC
    `,
    [filter || null]
  );

  return success({ items: result.rows });
}

async function createSavedQuery({
  ownerId,
  name,
  description,
  dataSourceId,
  sql,
  defaultRunParams,
  parameterSchema
}) {
  const trimmedOwnerId = String(ownerId || "anonymous").trim() || "anonymous";
  const trimmedDataSourceId = String(dataSourceId || "").trim();
  const trimmedName = typeof name === "string" ? name.trim() : "";
  const trimmedSql = typeof sql === "string" ? sql.trim() : "";
  const normalizedDescription = normalizeOptionalTrimmedString(description);
  const defaultRunParamsValidation = validateSavedQueryDefaultRunParams(defaultRunParams);
  const parameterSchemaValidation = resolveParameterSchema(trimmedSql, parameterSchema, []);

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
  if (!defaultRunParamsValidation.ok) {
    return failure(400, { error: "bad_request", message: defaultRunParamsValidation.message });
  }
  if (!parameterSchemaValidation.ok) {
    return failure(400, { error: "bad_request", message: parameterSchemaValidation.message });
  }

  if (!(await ensureDataSourceExists(trimmedDataSourceId))) {
    return failure(404, { error: "not_found", message: "Data source not found" });
  }

  try {
    const insertResult = await appDb.query(
      `
        INSERT INTO saved_queries (
          owner_id,
          name,
          description,
          data_source_id,
          sql,
          default_run_params,
          parameter_schema
        ) VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb)
        RETURNING ${SAVED_QUERY_COLUMNS}
      `,
      [
        trimmedOwnerId,
        trimmedName,
        normalizedDescription,
        trimmedDataSourceId,
        trimmedSql,
        JSON.stringify(defaultRunParamsValidation.value),
        JSON.stringify(parameterSchemaValidation.value)
      ]
    );

    return success(insertResult.rows[0], 201);
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

async function updateSavedQuery(savedQueryId, {
  name,
  description,
  dataSourceId,
  sql,
  defaultRunParams,
  parameterSchema
}) {
  if (!isUuid(savedQueryId)) {
    return failure(400, { error: "bad_request", message: "savedQueryId must be a valid UUID" });
  }

  const existing = await loadSavedQuery(savedQueryId);
  if (!existing) {
    return failure(404, { error: "not_found", message: "Saved query not found" });
  }

  const trimmedDataSourceId = String(dataSourceId || "").trim();
  const trimmedName = typeof name === "string" ? name.trim() : "";
  const trimmedSql = typeof sql === "string" ? sql.trim() : "";
  const normalizedDescription = normalizeOptionalTrimmedString(description);
  const defaultRunParamsValidation = validateSavedQueryDefaultRunParams(defaultRunParams);
  const parameterSchemaValidation = resolveParameterSchema(trimmedSql, parameterSchema, existing.parameter_schema);

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
  if (!defaultRunParamsValidation.ok) {
    return failure(400, { error: "bad_request", message: defaultRunParamsValidation.message });
  }
  if (!parameterSchemaValidation.ok) {
    return failure(400, { error: "bad_request", message: parameterSchemaValidation.message });
  }

  if (!(await ensureDataSourceExists(trimmedDataSourceId))) {
    return failure(404, { error: "not_found", message: "Data source not found" });
  }

  try {
    const updateResult = await appDb.query(
      `
        UPDATE saved_queries
        SET
          name = $2,
          description = $3,
          data_source_id = $4,
          sql = $5,
          default_run_params = $6::jsonb,
          parameter_schema = $7::jsonb,
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
        JSON.stringify(parameterSchemaValidation.value)
      ]
    );

    return success(updateResult.rows[0]);
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

async function deleteSavedQuery(savedQueryId) {
  if (!isUuid(savedQueryId)) {
    return failure(400, { error: "bad_request", message: "savedQueryId must be a valid UUID" });
  }

  const deleteResult = await appDb.query(
    `DELETE FROM saved_queries WHERE id = $1 RETURNING id`,
    [savedQueryId]
  );

  if (deleteResult.rowCount === 0) {
    return failure(404, { error: "not_found", message: "Saved query not found" });
  }

  return success({ ok: true, id: deleteResult.rows[0].id });
}

async function validateSavedQueryParams(savedQueryId, providedParams) {
  if (!isUuid(savedQueryId)) {
    return failure(400, { error: "bad_request", message: "savedQueryId must be a valid UUID" });
  }

  const savedQuery = await loadSavedQuery(savedQueryId);
  if (!savedQuery) {
    return failure(404, { error: "not_found", message: "Saved query not found" });
  }

  const validation = validateParameterValues(savedQuery.parameter_schema, providedParams);
  if (!validation.ok) {
    return success({ ok: false, errors: validation.errors });
  }

  return success({ ok: true, resolved_values: validation.resolvedValues });
}

async function executeSavedQuery(savedQueryId, { params, maxRows, timeoutMs } = {}) {
  if (!isUuid(savedQueryId)) {
    return failure(400, { error: "bad_request", message: "savedQueryId must be a valid UUID" });
  }

  const savedQuery = await loadSavedQueryForExecution(savedQueryId);
  if (!savedQuery) {
    return failure(404, { error: "not_found", message: "Saved query not found" });
  }
  if (!isSupportedDbType(savedQuery.db_type)) {
    return failure(400, {
      error: "bad_request",
      message: `Unsupported db_type for execution: ${savedQuery.db_type}`
    });
  }

  const parameterValidation = validateParameterValues(savedQuery.parameter_schema, params);
  if (!parameterValidation.ok) {
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

  let adapter = null;
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

module.exports = {
  getSavedQuery,
  listSavedQueries,
  createSavedQuery,
  updateSavedQuery,
  deleteSavedQuery,
  validateSavedQueryParams,
  executeSavedQuery
};
