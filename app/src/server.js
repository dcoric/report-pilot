const fs = require("fs");
const path = require("path");
const http = require("http");
const appDb = require("./lib/appDb");
const { createDatabaseAdapter, isSupportedDbType } = require("./adapters/dbAdapterFactory");
const { runIntrospection, persistSnapshot } = require("./services/introspectionService");
const { parseSchemaFromDdl } = require("./services/ddlImportService");
const { generateSqlWithRouting } = require("./services/llmSqlService");
const { validateAndNormalizeSql } = require("./services/sqlSafety");
const {
  extractForbiddenColumnsFromRagNotes,
  validateSqlAgainstForbiddenColumns
} = require("./services/columnPolicyService");
const { evaluateExplainBudget } = require("./services/queryBudget");
const { buildCitations, computeConfidence } = require("./services/queryResponse");
const { reindexRagDocuments } = require("./services/ragService");
const { retrieveRagContext } = require("./services/ragRetrieval");
const {
  buildObservabilityMetrics,
  loadLatestBenchmarkReleaseGates,
  buildBenchmarkCommand
} = require("./services/observabilityService");
const { exportQueryResult, SUPPORTED_FORMATS } = require("./services/exportService");
const { createDelivery, getDeliveryStatus } = require("./services/deliveryService");
const { OpenAiAdapter } = require("./adapters/llm/openAiAdapter");
const { GeminiAdapter } = require("./adapters/llm/geminiAdapter");
const { DeepSeekAdapter } = require("./adapters/llm/deepSeekAdapter");
const { OpenRouterAdapter } = require("./adapters/llm/openRouterAdapter");
const { CustomAdapter } = require("./adapters/llm/customAdapter");
const { resolveApiKey } = require("./adapters/llm/httpClient");
const { normalizeProviderUpsertInput } = require("./services/providerConfigService");
const { createRequestId, logEvent } = require("./lib/observability");
const { json, notFound, badRequest, internalError, readJsonBody } = require("./lib/http");

const PORT = Number(process.env.PORT || 8080);

const LLM_PROVIDERS = new Set(["openai", "gemini", "deepseek", "openrouter"]);
const ENTITY_TYPES = new Set(["table", "column", "metric", "dimension", "rule"]);
const ROUTING_STRATEGIES = new Set(["ordered_fallback", "cost_optimized", "latency_optimized"]);
const SCHEMA_OBJECT_TYPES = new Set(["table", "view", "materialized_view"]);
const RELATIONSHIP_TYPES = new Set(["fk", "inferred"]);
const EXAMPLE_SOURCES = new Set(["manual", "feedback"]);
const EXPLAIN_BUDGET_ENABLED = String(process.env.EXPLAIN_BUDGET_ENABLED || "true") === "true";
const EXPLAIN_MAX_TOTAL_COST = Number(process.env.EXPLAIN_MAX_TOTAL_COST || 500000);
const EXPLAIN_MAX_PLAN_ROWS = Number(process.env.EXPLAIN_MAX_PLAN_ROWS || 1000000);
const RAG_NOTE_TITLE_MAX_LENGTH = 200;
const RAG_NOTE_CONTENT_MAX_LENGTH = 20000;
const SAVED_QUERY_NAME_MAX_LENGTH = 200;
const SAVED_QUERY_DESCRIPTION_MAX_LENGTH = 1000;
const SAVED_QUERY_DEFAULT_RUN_PARAM_KEYS = new Set(["llm_provider", "model", "max_rows", "timeout_ms", "no_execute"]);
const OPENAPI_SPEC_PATH = path.resolve(__dirname, "../../docs/api/openapi.yaml");
const FRONTEND_DIST_PATH = path.resolve(__dirname, "../../frontend/dist");
const FRONTEND_INDEX_PATH = path.join(FRONTEND_DIST_PATH, "index.html");
const STATIC_CONTENT_TYPES = {
  ".css": "text/css; charset=utf-8",
  ".gif": "image/gif",
  ".html": "text/html; charset=utf-8",
  ".ico": "image/x-icon",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".txt": "text/plain; charset=utf-8",
  ".webp": "image/webp"
};

let cachedOpenApiSpec = null;
let cachedFrontendIndex = null;

function loadOpenApiSpec() {
  if (cachedOpenApiSpec === null) {
    cachedOpenApiSpec = fs.readFileSync(OPENAPI_SPEC_PATH, "utf8");
  }
  return cachedOpenApiSpec;
}

function swaggerUiHtml() {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Report Pilot API Docs</title>
    <link rel="stylesheet" href="https://unpkg.com/swagger-ui-dist@5/swagger-ui.css" />
  </head>
  <body>
    <div id="swagger-ui"></div>
    <script src="https://unpkg.com/swagger-ui-dist@5/swagger-ui-bundle.js"></script>
    <script>
      SwaggerUIBundle({
        url: "/openapi.yaml",
        dom_id: "#swagger-ui"
      });
    </script>
  </body>
</html>`;
}

function serveSwaggerDocs(res) {
  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  res.end(swaggerUiHtml());
}

function serveOpenApiSpec(res) {
  const spec = loadOpenApiSpec();
  res.writeHead(200, { "Content-Type": "application/yaml; charset=utf-8" });
  res.end(spec);
}

function frontendIsAvailable() {
  return fs.existsSync(FRONTEND_INDEX_PATH);
}

function getStaticContentType(filePath) {
  const extname = path.extname(filePath).toLowerCase();
  return STATIC_CONTENT_TYPES[extname] || "application/octet-stream";
}

function isPathWithin(parentPath, candidatePath) {
  const relativePath = path.relative(parentPath, candidatePath);
  return relativePath === "" || (!relativePath.startsWith("..") && !path.isAbsolute(relativePath));
}

function serveFrontendIndex(res) {
  if (!frontendIsAvailable()) {
    return false;
  }

  if (cachedFrontendIndex === null) {
    cachedFrontendIndex = fs.readFileSync(FRONTEND_INDEX_PATH);
  }

  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  res.end(cachedFrontendIndex);
  return true;
}

function serveFrontendAsset(res, pathname) {
  if (!frontendIsAvailable()) {
    return false;
  }

  const relativeAssetPath = decodeURIComponent(pathname).replace(/^\/+/, "");
  if (!relativeAssetPath) {
    return false;
  }

  const assetPath = path.resolve(FRONTEND_DIST_PATH, relativeAssetPath);
  if (!isPathWithin(FRONTEND_DIST_PATH, assetPath)) {
    return false;
  }

  if (!fs.existsSync(assetPath) || !fs.statSync(assetPath).isFile()) {
    return false;
  }

  const asset = fs.readFileSync(assetPath);
  res.writeHead(200, { "Content-Type": getStaticContentType(assetPath) });
  res.end(asset);
  return true;
}

function shouldServeFrontendApp(req, pathname) {
  if (req.method !== "GET" || !frontendIsAvailable()) {
    return false;
  }

  if (
    pathname === "/health" ||
    pathname === "/ready" ||
    pathname === "/docs" ||
    pathname === "/docs/" ||
    pathname === "/openapi.yaml" ||
    pathname.startsWith("/v1/")
  ) {
    return false;
  }

  if (path.extname(pathname)) {
    return false;
  }

  const accept = String(req.headers.accept || "");
  return accept.includes("text/html");
}

async function checkDatabase() {
  try {
    await appDb.query("SELECT 1");
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

function clamp(n, min, max) {
  return Math.max(min, Math.min(max, n));
}

function isUuid(value) {
  return typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isNonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function isNullableString(value) {
  return value === null || typeof value === "string";
}

function isFiniteNumber(value) {
  return typeof value === "number" && Number.isFinite(value);
}

function isInteger(value) {
  return Number.isInteger(value);
}

function isPgUniqueViolation(err) {
  return err && typeof err === "object" && err.code === "23505";
}

function normalizeOptionalTrimmedString(value) {
  if (value === undefined || value === null) {
    return null;
  }
  if (typeof value !== "string") {
    return null;
  }

  const trimmed = value.trim();
  return trimmed || null;
}

function validateSavedQueryDefaultRunParams(value) {
  if (value === undefined) {
    return { ok: true, value: {} };
  }

  if (!isPlainObject(value)) {
    return { ok: false, message: "default_run_params must be an object" };
  }

  const normalized = {};
  for (const [key, raw] of Object.entries(value)) {
    if (!SAVED_QUERY_DEFAULT_RUN_PARAM_KEYS.has(key)) {
      return { ok: false, message: "default_run_params contains unsupported keys" };
    }

    if (key === "llm_provider" || key === "model") {
      if (!isNonEmptyString(raw)) {
        return { ok: false, message: `default_run_params.${key} must be a non-empty string` };
      }
      normalized[key] = String(raw).trim();
      continue;
    }

    if (key === "max_rows") {
      if (!isInteger(raw) || raw < 1 || raw > 100000) {
        return { ok: false, message: "default_run_params.max_rows must be an integer between 1 and 100000" };
      }
      normalized[key] = raw;
      continue;
    }

    if (key === "timeout_ms") {
      if (!isInteger(raw) || raw < 1000 || raw > 120000) {
        return { ok: false, message: "default_run_params.timeout_ms must be an integer between 1000 and 120000" };
      }
      normalized[key] = raw;
      continue;
    }

    if (key === "no_execute") {
      if (typeof raw !== "boolean") {
        return { ok: false, message: "default_run_params.no_execute must be a boolean" };
      }
      normalized[key] = raw;
    }
  }

  return { ok: true, value: normalized };
}

function groupByKey(rows, key) {
  const map = {};
  for (const row of rows) {
    const k = row[key];
    if (!map[k]) map[k] = [];
    map[k].push(row);
  }
  return map;
}

function validateDataSourceImportPayload(body) {
  if (!isPlainObject(body)) {
    return "Invalid export file: request body must be a JSON object";
  }
  if (!Number.isInteger(body.version) || body.version < 1) {
    return "Invalid export file: version must be a positive integer";
  }
  if (!isPlainObject(body.data_source)) {
    return "Invalid export file: data_source must be an object";
  }

  const ds = body.data_source;
  if (!isNonEmptyString(ds.name) || !isNonEmptyString(ds.db_type) || !isNonEmptyString(ds.connection_ref)) {
    return "data_source must include non-empty name, db_type and connection_ref";
  }

  const schemaObjects = body.schema_objects || [];
  if (!Array.isArray(schemaObjects)) {
    return "schema_objects must be an array";
  }
  for (let idx = 0; idx < schemaObjects.length; idx += 1) {
    const obj = schemaObjects[idx];
    if (!isPlainObject(obj)) {
      return `schema_objects[${idx}] must be an object`;
    }
    if (!SCHEMA_OBJECT_TYPES.has(obj.object_type)) {
      return `schema_objects[${idx}].object_type must be one of: table, view, materialized_view`;
    }
    if (!isNonEmptyString(obj.schema_name) || !isNonEmptyString(obj.object_name)) {
      return `schema_objects[${idx}] must include non-empty schema_name and object_name`;
    }
    if (!(obj.description === undefined || isNullableString(obj.description))) {
      return `schema_objects[${idx}].description must be a string or null`;
    }
    if (!(obj.is_ignored === undefined || typeof obj.is_ignored === "boolean")) {
      return `schema_objects[${idx}].is_ignored must be a boolean`;
    }
    if (!(obj.columns === undefined || Array.isArray(obj.columns))) {
      return `schema_objects[${idx}].columns must be an array`;
    }
    if (!(obj.relationships === undefined || Array.isArray(obj.relationships))) {
      return `schema_objects[${idx}].relationships must be an array`;
    }
    if (!(obj.indexes === undefined || Array.isArray(obj.indexes))) {
      return `schema_objects[${idx}].indexes must be an array`;
    }

    for (let colIdx = 0; colIdx < (obj.columns || []).length; colIdx += 1) {
      const col = obj.columns[colIdx];
      if (!isPlainObject(col)) {
        return `schema_objects[${idx}].columns[${colIdx}] must be an object`;
      }
      if (!isNonEmptyString(col.column_name) || !isNonEmptyString(col.data_type)) {
        return `schema_objects[${idx}].columns[${colIdx}] must include non-empty column_name and data_type`;
      }
      if (typeof col.nullable !== "boolean" || typeof col.is_pk !== "boolean") {
        return `schema_objects[${idx}].columns[${colIdx}] must include boolean nullable and is_pk`;
      }
      if (!Number.isInteger(col.ordinal_position) || col.ordinal_position < 1) {
        return `schema_objects[${idx}].columns[${colIdx}].ordinal_position must be a positive integer`;
      }
    }

    for (let relIdx = 0; relIdx < (obj.relationships || []).length; relIdx += 1) {
      const rel = obj.relationships[relIdx];
      if (!isPlainObject(rel)) {
        return `schema_objects[${idx}].relationships[${relIdx}] must be an object`;
      }
      if (
        !isNonEmptyString(rel.from_column) ||
        !isNonEmptyString(rel.to_schema) ||
        !isNonEmptyString(rel.to_object) ||
        !isNonEmptyString(rel.to_column)
      ) {
        return `schema_objects[${idx}].relationships[${relIdx}] must include non-empty from_column, to_schema, to_object and to_column`;
      }
      if (!RELATIONSHIP_TYPES.has(rel.relationship_type)) {
        return `schema_objects[${idx}].relationships[${relIdx}].relationship_type must be one of: fk, inferred`;
      }
    }

    for (let indexIdx = 0; indexIdx < (obj.indexes || []).length; indexIdx += 1) {
      const entry = obj.indexes[indexIdx];
      if (!isPlainObject(entry)) {
        return `schema_objects[${idx}].indexes[${indexIdx}] must be an object`;
      }
      if (!isNonEmptyString(entry.index_name)) {
        return `schema_objects[${idx}].indexes[${indexIdx}].index_name must be a non-empty string`;
      }
      if (!Array.isArray(entry.columns) || entry.columns.some((value) => !isNonEmptyString(value))) {
        return `schema_objects[${idx}].indexes[${indexIdx}].columns must be an array of non-empty strings`;
      }
      if (typeof entry.is_unique !== "boolean") {
        return `schema_objects[${idx}].indexes[${indexIdx}].is_unique must be a boolean`;
      }
    }
  }

  const ragNotes = body.rag_notes || [];
  if (!Array.isArray(ragNotes)) {
    return "rag_notes must be an array";
  }
  for (let idx = 0; idx < ragNotes.length; idx += 1) {
    const note = ragNotes[idx];
    if (!isPlainObject(note)) {
      return `rag_notes[${idx}] must be an object`;
    }
    if (!isNonEmptyString(note.title) || !isNonEmptyString(note.content)) {
      return `rag_notes[${idx}] must include non-empty title and content`;
    }
    if (!(note.active === undefined || typeof note.active === "boolean")) {
      return `rag_notes[${idx}].active must be a boolean`;
    }
  }

  const semanticEntities = body.semantic_entities || [];
  if (!Array.isArray(semanticEntities)) {
    return "semantic_entities must be an array";
  }
  for (let idx = 0; idx < semanticEntities.length; idx += 1) {
    const entity = semanticEntities[idx];
    if (!isPlainObject(entity)) {
      return `semantic_entities[${idx}] must be an object`;
    }
    if (!ENTITY_TYPES.has(entity.entity_type)) {
      return `semantic_entities[${idx}].entity_type is invalid`;
    }
    if (!isNonEmptyString(entity.target_ref) || !isNonEmptyString(entity.business_name)) {
      return `semantic_entities[${idx}] must include non-empty target_ref and business_name`;
    }
    if (!(entity.description === undefined || isNullableString(entity.description))) {
      return `semantic_entities[${idx}].description must be a string or null`;
    }
    if (!(entity.owner === undefined || isNullableString(entity.owner))) {
      return `semantic_entities[${idx}].owner must be a string or null`;
    }
    if (!(entity.active === undefined || typeof entity.active === "boolean")) {
      return `semantic_entities[${idx}].active must be a boolean`;
    }
    if (!(entity.metric_definitions === undefined || Array.isArray(entity.metric_definitions))) {
      return `semantic_entities[${idx}].metric_definitions must be an array`;
    }
    for (let metricIdx = 0; metricIdx < (entity.metric_definitions || []).length; metricIdx += 1) {
      const metric = entity.metric_definitions[metricIdx];
      if (!isPlainObject(metric)) {
        return `semantic_entities[${idx}].metric_definitions[${metricIdx}] must be an object`;
      }
      if (!isNonEmptyString(metric.sql_expression)) {
        return `semantic_entities[${idx}].metric_definitions[${metricIdx}].sql_expression must be a non-empty string`;
      }
      if (!(metric.grain === undefined || isNullableString(metric.grain))) {
        return `semantic_entities[${idx}].metric_definitions[${metricIdx}].grain must be a string or null`;
      }
    }
  }

  const joinPolicies = body.join_policies || [];
  if (!Array.isArray(joinPolicies)) {
    return "join_policies must be an array";
  }
  for (let idx = 0; idx < joinPolicies.length; idx += 1) {
    const policy = joinPolicies[idx];
    if (!isPlainObject(policy)) {
      return `join_policies[${idx}] must be an object`;
    }
    if (
      !isNonEmptyString(policy.left_ref) ||
      !isNonEmptyString(policy.right_ref) ||
      !isNonEmptyString(policy.join_type) ||
      !isNonEmptyString(policy.on_clause)
    ) {
      return `join_policies[${idx}] must include non-empty left_ref, right_ref, join_type and on_clause`;
    }
    if (!(policy.approved === undefined || typeof policy.approved === "boolean")) {
      return `join_policies[${idx}].approved must be a boolean`;
    }
    if (!(policy.notes === undefined || isNullableString(policy.notes))) {
      return `join_policies[${idx}].notes must be a string or null`;
    }
  }

  const examples = body.nl_sql_examples || [];
  if (!Array.isArray(examples)) {
    return "nl_sql_examples must be an array";
  }
  for (let idx = 0; idx < examples.length; idx += 1) {
    const example = examples[idx];
    if (!isPlainObject(example)) {
      return `nl_sql_examples[${idx}] must be an object`;
    }
    if (!isNonEmptyString(example.question) || !isNonEmptyString(example.sql)) {
      return `nl_sql_examples[${idx}] must include non-empty question and sql`;
    }
    if (!(example.quality_score === undefined || example.quality_score === null || isFiniteNumber(example.quality_score))) {
      return `nl_sql_examples[${idx}].quality_score must be a number or null`;
    }
    if (!(example.source === undefined || EXAMPLE_SOURCES.has(example.source))) {
      return `nl_sql_examples[${idx}].source must be one of: manual, feedback`;
    }
  }

  const synonyms = body.synonyms || [];
  if (!Array.isArray(synonyms)) {
    return "synonyms must be an array";
  }
  for (let idx = 0; idx < synonyms.length; idx += 1) {
    const synonym = synonyms[idx];
    if (!isPlainObject(synonym)) {
      return `synonyms[${idx}] must be an object`;
    }
    if (!isNonEmptyString(synonym.term) || !isNonEmptyString(synonym.maps_to_ref)) {
      return `synonyms[${idx}] must include non-empty term and maps_to_ref`;
    }
    if (!(synonym.weight === undefined || synonym.weight === null || isFiniteNumber(synonym.weight))) {
      return `synonyms[${idx}].weight must be a number or null`;
    }
  }

  return null;
}

function isLikelyInvalidSqlExecutionError(err, dialect = "postgres") {
  const message = String(err?.message || "");
  if (!message) {
    return false;
  }

  const commonPatterns = [
    /syntax error/i,
    /incorrect syntax/i
  ];
  const mssqlPatterns = [
    /invalid column name/i,
    /invalid object name/i,
    /ambiguous column name/i,
    /multi-part identifier .* could not be bound/i
  ];
  const postgresPatterns = [
    /column .* does not exist/i,
    /relation .* does not exist/i,
    /missing from-clause entry/i
  ];

  const patterns = dialect === "mssql"
    ? [...commonPatterns, ...mssqlPatterns]
    : [...commonPatterns, ...postgresPatterns];
  return patterns.some((pattern) => pattern.test(message));
}

function triggerRagReindexAsync(dataSourceId) {
  if (!dataSourceId) {
    return;
  }
  setImmediate(() => {
    reindexRagDocuments(dataSourceId).catch((err) => {
      console.error(`[rag] reindex failed for ${dataSourceId}: ${err.message}`);
    });
  });
}

async function handleCreateDataSource(req, res) {
  const body = await readJsonBody(req);
  const { name, db_type: dbType, connection_ref: connectionRef } = body;
  const normalizedDbType = String(dbType || "").trim().toLowerCase();

  if (!name || !dbType || !connectionRef) {
    return badRequest(res, "name, db_type and connection_ref are required");
  }

  if (!isSupportedDbType(normalizedDbType)) {
    return badRequest(res, "Unsupported db_type. Supported values: postgres, mssql");
  }

  const result = await appDb.query(
    `
      INSERT INTO data_sources (name, db_type, connection_ref, status)
      VALUES ($1, $2, $3, 'active')
      RETURNING id, name, db_type, status
    `,
    [name, normalizedDbType, connectionRef]
  );

  return json(res, 201, result.rows[0]);
}

async function handleListDataSources(_req, res) {
  const result = await appDb.query(
    `
      SELECT id, name, db_type, connection_ref, status, created_at
      FROM data_sources
      ORDER BY created_at DESC
    `
  );

  return json(res, 200, { items: result.rows });
}

async function handleDeleteDataSource(_req, res, dataSourceId) {
  const result = await appDb.query(
    "DELETE FROM data_sources WHERE id = $1 RETURNING id",
    [dataSourceId]
  );

  if (result.rowCount === 0) {
    return json(res, 404, { error: "not_found", message: "Data source not found" });
  }

  return json(res, 200, { ok: true, id: dataSourceId });
}

async function runIntrospectionJob(jobId, dataSource) {
  try {
    await appDb.query(
      `
        UPDATE introspection_jobs
        SET status = 'running', updated_at = NOW()
        WHERE id = $1
      `,
      [jobId]
    );

    await runIntrospection(dataSource);
    await reindexRagDocuments(dataSource.id);

    await appDb.query(
      `
        UPDATE introspection_jobs
        SET status = 'succeeded', updated_at = NOW()
        WHERE id = $1
      `,
      [jobId]
    );
  } catch (err) {
    await appDb.query(
      `
        UPDATE introspection_jobs
        SET status = 'failed', error_message = $2, updated_at = NOW()
        WHERE id = $1
      `,
      [jobId, err.message]
    );
    console.error(`[introspection] Job ${jobId} failed: ${err.message}`);
  }
}

async function handleIntrospect(req, res, dataSourceId) {
  const result = await appDb.query(
    "SELECT id, db_type, connection_ref FROM data_sources WHERE id = $1",
    [dataSourceId]
  );
  const dataSource = result.rows[0];
  if (!dataSource) {
    return json(res, 404, { error: "not_found", message: "Data source not found" });
  }

  if (!isSupportedDbType(dataSource.db_type)) {
    return badRequest(res, `Unsupported db_type for introspection: ${dataSource.db_type}`);
  }

  const jobInsert = await appDb.query(
    `
      INSERT INTO introspection_jobs (data_source_id, status)
      VALUES ($1, 'queued')
      RETURNING id
    `,
    [dataSourceId]
  );
  const jobId = jobInsert.rows[0].id;

  setImmediate(() => {
    runIntrospectionJob(jobId, dataSource).catch((err) => {
      console.error(`[introspection] Unexpected error for job ${jobId}: ${err.message}`);
    });
  });

  return json(res, 202, { job_id: jobId, status: "queued" });
}

async function handleImportSchema(req, res, dataSourceId) {
  const result = await appDb.query(
    "SELECT id, db_type FROM data_sources WHERE id = $1",
    [dataSourceId]
  );
  const dataSource = result.rows[0];
  if (!dataSource) {
    return json(res, 404, { error: "not_found", message: "Data source not found" });
  }

  const body = await readJsonBody(req);
  const ddl = String(body.ddl || "").trim();
  if (!ddl) {
    return badRequest(res, "ddl field is required and must be a non-empty string");
  }

  const snapshot = parseSchemaFromDdl(ddl);
  if (snapshot.objects.length === 0) {
    return badRequest(res, "No tables or views found in the provided DDL");
  }

  await persistSnapshot(dataSourceId, snapshot);
  reindexRagDocuments(dataSourceId).catch((err) => {
    console.error(`[import-schema] RAG reindex failed for ${dataSourceId}: ${err.message}`);
  });

  return json(res, 200, { ok: true, object_count: snapshot.objects.length });
}

async function handleExportDataSource(_req, res, dataSourceId) {
  if (!isUuid(dataSourceId)) {
    return badRequest(res, "dataSourceId must be a valid UUID");
  }

  const dsResult = await appDb.query(
    "SELECT id, name, db_type, connection_ref FROM data_sources WHERE id = $1",
    [dataSourceId]
  );
  if (dsResult.rowCount === 0) {
    return json(res, 404, { error: "not_found", message: "Data source not found" });
  }
  const ds = dsResult.rows[0];

  const [
    schemaObjectsResult,
    ragNotesResult,
    semanticEntitiesResult,
    joinPoliciesResult,
    examplesResult,
    synonymsResult
  ] = await Promise.all([
    appDb.query(
      `SELECT id, object_type, schema_name, object_name, description, is_ignored
       FROM schema_objects WHERE data_source_id = $1
       ORDER BY schema_name, object_name`,
      [dataSourceId]
    ),
    appDb.query(
      `SELECT title, content, active
       FROM rag_notes WHERE data_source_id = $1
       ORDER BY created_at`,
      [dataSourceId]
    ),
    appDb.query(
      `SELECT id, entity_type, target_ref, business_name, description, owner, active
       FROM semantic_entities WHERE data_source_id = $1
       ORDER BY entity_type, business_name`,
      [dataSourceId]
    ),
    appDb.query(
      `SELECT left_ref, right_ref, join_type, on_clause, approved, notes
       FROM join_policies WHERE data_source_id = $1
       ORDER BY left_ref, right_ref`,
      [dataSourceId]
    ),
    appDb.query(
      `SELECT question, sql, quality_score, source
       FROM nl_sql_examples WHERE data_source_id = $1
       ORDER BY created_at`,
      [dataSourceId]
    ),
    appDb.query(
      `SELECT term, maps_to_ref, weight
       FROM synonyms WHERE data_source_id = $1
       ORDER BY term`,
      [dataSourceId]
    )
  ]);

  const objectIds = schemaObjectsResult.rows.map((o) => o.id);

  let columnsResult = { rows: [] };
  let relationshipsResult = { rows: [] };
  let indexesResult = { rows: [] };

  if (objectIds.length > 0) {
    [columnsResult, relationshipsResult, indexesResult] = await Promise.all([
      appDb.query(
        `SELECT schema_object_id, column_name, data_type, nullable, is_pk, ordinal_position
         FROM columns
         WHERE schema_object_id = ANY($1)
         ORDER BY schema_object_id, ordinal_position`,
        [objectIds]
      ),
      appDb.query(
        `SELECT from_object_id, from_column, to_object_id, to_column, relationship_type
         FROM relationships
         WHERE from_object_id = ANY($1)`,
        [objectIds]
      ),
      appDb.query(
        `SELECT schema_object_id, index_name, columns, is_unique
         FROM indexes
         WHERE schema_object_id = ANY($1)
         ORDER BY schema_object_id, index_name`,
        [objectIds]
      )
    ]);
  }

  const seIds = semanticEntitiesResult.rows.map((se) => se.id);
  let metricDefsResult = { rows: [] };
  if (seIds.length > 0) {
    metricDefsResult = await appDb.query(
      `SELECT semantic_entity_id, sql_expression, grain, filters_json
       FROM metric_definitions WHERE semantic_entity_id = ANY($1)`,
      [seIds]
    );
  }

  const objectById = new Map(schemaObjectsResult.rows.map((o) => [o.id, o]));
  const columnsByObj = groupByKey(columnsResult.rows, "schema_object_id");
  const relsByObj = groupByKey(relationshipsResult.rows, "from_object_id");
  const idxByObj = groupByKey(indexesResult.rows, "schema_object_id");
  const metricsBySe = groupByKey(metricDefsResult.rows, "semantic_entity_id");

  const schemaObjects = schemaObjectsResult.rows.map((obj) => ({
    object_type: obj.object_type,
    schema_name: obj.schema_name,
    object_name: obj.object_name,
    description: obj.description,
    is_ignored: obj.is_ignored,
    columns: (columnsByObj[obj.id] || []).map((c) => ({
      column_name: c.column_name,
      data_type: c.data_type,
      nullable: c.nullable,
      is_pk: c.is_pk,
      ordinal_position: c.ordinal_position
    })),
    relationships: (relsByObj[obj.id] || []).map((r) => {
      const toObj = objectById.get(r.to_object_id);
      return {
        from_column: r.from_column,
        to_schema: toObj ? toObj.schema_name : null,
        to_object: toObj ? toObj.object_name : null,
        to_column: r.to_column,
        relationship_type: r.relationship_type
      };
    }),
    indexes: (idxByObj[obj.id] || []).map((i) => ({
      index_name: i.index_name,
      columns: i.columns,
      is_unique: i.is_unique
    }))
  }));

  const semanticEntities = semanticEntitiesResult.rows.map((se) => ({
    entity_type: se.entity_type,
    target_ref: se.target_ref,
    business_name: se.business_name,
    description: se.description,
    owner: se.owner,
    active: se.active,
    metric_definitions: (metricsBySe[se.id] || []).map((md) => ({
      sql_expression: md.sql_expression,
      grain: md.grain,
      filters_json: md.filters_json
    }))
  }));

  const payload = {
    version: 1,
    exported_at: new Date().toISOString(),
    data_source: {
      name: ds.name,
      db_type: ds.db_type,
      connection_ref: ds.connection_ref
    },
    schema_objects: schemaObjects,
    rag_notes: ragNotesResult.rows.map((n) => ({
      title: n.title,
      content: n.content,
      active: n.active
    })),
    semantic_entities: semanticEntities,
    join_policies: joinPoliciesResult.rows,
    nl_sql_examples: examplesResult.rows,
    synonyms: synonymsResult.rows
  };

  const filename = `${ds.name.replace(/[^a-zA-Z0-9_-]/g, "_")}_export.json`;
  res.writeHead(200, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Disposition": `attachment; filename="${filename}"`
  });
  return res.end(JSON.stringify(payload, null, 2));
}

async function handleImportDataSource(req, res) {
  const body = await readJsonBody(req);

  const validationError = validateDataSourceImportPayload(body);
  if (validationError) {
    return badRequest(res, validationError);
  }

  const ds = body.data_source;
  const normalizedDbType = String(ds.db_type).trim().toLowerCase();
  if (!isSupportedDbType(normalizedDbType)) {
    return badRequest(res, "Unsupported db_type. Supported values: postgres, mssql");
  }

  const dataSourceId = await appDb.withTransaction(async (client) => {
    const dsInsert = await client.query(
      `INSERT INTO data_sources (name, db_type, connection_ref, status)
       VALUES ($1, $2, $3, 'active')
       RETURNING id`,
      [ds.name, normalizedDbType, ds.connection_ref]
    );
    const newDsId = dsInsert.rows[0].id;

    const objectIdByKey = new Map();
    for (const obj of (body.schema_objects || [])) {
      const objInsert = await client.query(
        `INSERT INTO schema_objects (data_source_id, object_type, schema_name, object_name, description, is_ignored, hash, last_seen_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())
         RETURNING id`,
        [newDsId, obj.object_type, obj.schema_name, obj.object_name, obj.description || null, obj.is_ignored === true, "imported"]
      );
      const objId = objInsert.rows[0].id;
      objectIdByKey.set(`${obj.schema_name}.${obj.object_name}`.toLowerCase(), objId);

      for (const col of (obj.columns || [])) {
        await client.query(
          `INSERT INTO columns (schema_object_id, column_name, data_type, nullable, is_pk, ordinal_position)
           VALUES ($1, $2, $3, $4, $5, $6)`,
          [objId, col.column_name, col.data_type, col.nullable, col.is_pk, col.ordinal_position]
        );
      }

      for (const idx of (obj.indexes || [])) {
        await client.query(
          `INSERT INTO indexes (schema_object_id, index_name, columns, is_unique)
           VALUES ($1, $2, $3, $4)`,
          [objId, idx.index_name, idx.columns, idx.is_unique]
        );
      }
    }

    for (const obj of (body.schema_objects || [])) {
      const fromKey = `${obj.schema_name}.${obj.object_name}`.toLowerCase();
      const fromId = objectIdByKey.get(fromKey);
      if (!fromId) continue;

      for (const rel of (obj.relationships || [])) {
        const toKey = `${rel.to_schema}.${rel.to_object}`.toLowerCase();
        const toId = objectIdByKey.get(toKey);
        if (!toId) continue;

        await client.query(
          `INSERT INTO relationships (from_object_id, from_column, to_object_id, to_column, relationship_type)
           VALUES ($1, $2, $3, $4, $5)`,
          [fromId, rel.from_column, toId, rel.to_column, rel.relationship_type]
        );
      }
    }

    for (const note of (body.rag_notes || [])) {
      await client.query(
        `INSERT INTO rag_notes (data_source_id, title, content, active, created_by, updated_by)
         VALUES ($1, $2, $3, $4, 'import', 'import')`,
        [newDsId, note.title, note.content, note.active !== false]
      );
    }

    for (const se of (body.semantic_entities || [])) {
      const seInsert = await client.query(
        `INSERT INTO semantic_entities (data_source_id, entity_type, target_ref, business_name, description, owner, active)
         VALUES ($1, $2, $3, $4, $5, $6, COALESCE($7, TRUE))
         RETURNING id`,
        [newDsId, se.entity_type, se.target_ref, se.business_name, se.description || null, se.owner || null, se.active]
      );
      const seId = seInsert.rows[0].id;

      for (const md of (se.metric_definitions || [])) {
        await client.query(
          `INSERT INTO metric_definitions (semantic_entity_id, sql_expression, grain, filters_json)
           VALUES ($1, $2, $3, $4)`,
          [seId, md.sql_expression, md.grain || null, md.filters_json || null]
        );
      }
    }

    for (const jp of (body.join_policies || [])) {
      await client.query(
        `INSERT INTO join_policies (data_source_id, left_ref, right_ref, join_type, on_clause, approved, notes)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [newDsId, jp.left_ref, jp.right_ref, jp.join_type, jp.on_clause, jp.approved !== false, jp.notes || null]
      );
    }

    for (const ex of (body.nl_sql_examples || [])) {
      await client.query(
        `INSERT INTO nl_sql_examples (data_source_id, question, sql, quality_score, source)
         VALUES ($1, $2, $3, $4, $5)`,
        [newDsId, ex.question, ex.sql, ex.quality_score || null, ex.source || "manual"]
      );
    }

    for (const syn of (body.synonyms || [])) {
      await client.query(
        `INSERT INTO synonyms (data_source_id, term, maps_to_ref, weight)
         VALUES ($1, $2, $3, $4)`,
        [newDsId, syn.term, syn.maps_to_ref, syn.weight || 1.0]
      );
    }

    return newDsId;
  });

  try {
    await reindexRagDocuments(dataSourceId);
  } catch (err) {
    logEvent("data_source_import_reindex_failed", { data_source_id: dataSourceId, error: err.message }, "error");
    return json(res, 500, {
      error: "internal_error",
      message: `Data source was imported but RAG reindex failed: ${err.message}`,
      data_source_id: dataSourceId
    });
  }

  return json(res, 201, { ok: true, data_source_id: dataSourceId });
}

async function handleListSchemaObjects(req, res, requestUrl) {
  const dataSourceId = requestUrl.searchParams.get("data_source_id");
  if (!dataSourceId) {
    return badRequest(res, "data_source_id query parameter is required");
  }

  const result = await appDb.query(
    `
      SELECT id, object_type, schema_name, object_name, description, is_ignored
      FROM schema_objects
      WHERE data_source_id = $1
      ORDER BY schema_name, object_name
    `,
    [dataSourceId]
  );

  return json(res, 200, { items: result.rows });
}

async function handlePatchSchemaObject(req, res, schemaObjectId) {
  if (!isUuid(schemaObjectId)) {
    return badRequest(res, "schemaObjectId must be a valid UUID");
  }

  const body = await readJsonBody(req);
  if (!Object.prototype.hasOwnProperty.call(body, "is_ignored")) {
    return badRequest(res, "is_ignored is required");
  }
  if (typeof body.is_ignored !== "boolean") {
    return badRequest(res, "is_ignored must be a boolean");
  }

  const result = await appDb.query(
    `
      UPDATE schema_objects
      SET is_ignored = $2
      WHERE id = $1
      RETURNING
        id,
        data_source_id,
        object_type,
        schema_name,
        object_name,
        description,
        is_ignored
    `,
    [schemaObjectId, body.is_ignored]
  );

  if (result.rowCount === 0) {
    return json(res, 404, { error: "not_found", message: "Schema object not found" });
  }

  triggerRagReindexAsync(result.rows[0].data_source_id);

  return json(res, 200, result.rows[0]);
}

async function handleListRagNotes(_req, res, requestUrl) {
  const dataSourceId = String(requestUrl.searchParams.get("data_source_id") || "").trim();
  if (!dataSourceId) {
    return badRequest(res, "data_source_id query parameter is required");
  }
  if (!isUuid(dataSourceId)) {
    return badRequest(res, "data_source_id must be a valid UUID");
  }

  const result = await appDb.query(
    `
      SELECT
        id,
        data_source_id,
        title,
        content,
        active,
        created_at,
        updated_at
      FROM rag_notes
      WHERE data_source_id = $1
      ORDER BY updated_at DESC, created_at DESC
    `,
    [dataSourceId]
  );

  return json(res, 200, { items: result.rows });
}

async function handleUpsertRagNote(req, res) {
  const body = await readJsonBody(req);
  const id = body.id ? String(body.id).trim() : null;
  const dataSourceId = String(body.data_source_id || "").trim();
  const title = typeof body.title === "string" ? body.title.trim() : "";
  const content = typeof body.content === "string" ? body.content.trim() : "";
  const hasActive = Object.prototype.hasOwnProperty.call(body, "active");
  const active = hasActive && typeof body.active === "boolean" ? body.active : null;

  if (!dataSourceId || !title || !content) {
    return badRequest(res, "data_source_id, title and content are required");
  }
  if (!isUuid(dataSourceId)) {
    return badRequest(res, "data_source_id must be a valid UUID");
  }
  if (id && !isUuid(id)) {
    return badRequest(res, "id must be a valid UUID");
  }
  if (hasActive && typeof body.active !== "boolean") {
    return badRequest(res, "active must be a boolean");
  }
  if (title.length > RAG_NOTE_TITLE_MAX_LENGTH) {
    return badRequest(res, `title cannot exceed ${RAG_NOTE_TITLE_MAX_LENGTH} characters`);
  }
  if (content.length > RAG_NOTE_CONTENT_MAX_LENGTH) {
    return badRequest(res, `content cannot exceed ${RAG_NOTE_CONTENT_MAX_LENGTH} characters`);
  }

  const sourceResult = await appDb.query("SELECT id FROM data_sources WHERE id = $1", [dataSourceId]);
  if (sourceResult.rowCount === 0) {
    return json(res, 404, { error: "not_found", message: "Data source not found" });
  }

  const userId = String(req.headers["x-user-id"] || "anonymous").trim() || "anonymous";

  if (id) {
    const updateResult = await appDb.query(
      `
        UPDATE rag_notes
        SET
          data_source_id = $2,
          title = $3,
          content = $4,
          active = COALESCE($5, active),
          updated_by = $6,
          updated_at = NOW()
        WHERE id = $1
        RETURNING
          id,
          data_source_id,
          title,
          content,
          active,
          created_at,
          updated_at
      `,
      [id, dataSourceId, title, content, active, userId]
    );

    if (updateResult.rowCount === 0) {
      return json(res, 404, { error: "not_found", message: "RAG note not found" });
    }

    triggerRagReindexAsync(updateResult.rows[0].data_source_id);
    return json(res, 200, updateResult.rows[0]);
  }

  const insertResult = await appDb.query(
    `
      INSERT INTO rag_notes (
        data_source_id,
        title,
        content,
        active,
        created_by,
        updated_by
      ) VALUES ($1, $2, $3, $4, $5, $5)
      RETURNING
        id,
        data_source_id,
        title,
        content,
        active,
        created_at,
        updated_at
    `,
    [dataSourceId, title, content, active === null ? true : active, userId]
  );

  triggerRagReindexAsync(dataSourceId);
  return json(res, 200, insertResult.rows[0]);
}

async function handleDeleteRagNote(_req, res, noteId) {
  if (!isUuid(noteId)) {
    return badRequest(res, "noteId must be a valid UUID");
  }

  const deleteResult = await appDb.query(
    `
      DELETE FROM rag_notes
      WHERE id = $1
      RETURNING id, data_source_id
    `,
    [noteId]
  );

  if (deleteResult.rowCount === 0) {
    return json(res, 404, { error: "not_found", message: "RAG note not found" });
  }

  triggerRagReindexAsync(deleteResult.rows[0].data_source_id);
  return json(res, 200, { ok: true, id: deleteResult.rows[0].id });
}

async function handleUpsertSemanticEntity(req, res) {
  const body = await readJsonBody(req);
  const {
    id,
    data_source_id: dataSourceId,
    entity_type: entityType,
    target_ref: targetRef,
    business_name: businessName,
    description,
    owner,
    active
  } = body;

  if (!dataSourceId || !entityType || !targetRef || !businessName) {
    return badRequest(res, "data_source_id, entity_type, target_ref and business_name are required");
  }

  if (!ENTITY_TYPES.has(entityType)) {
    return badRequest(res, "Invalid entity_type");
  }

  if (id) {
    const updateResult = await appDb.query(
      `
        UPDATE semantic_entities
        SET
          data_source_id = $2,
          entity_type = $3,
          target_ref = $4,
          business_name = $5,
          description = $6,
          owner = $7,
          active = COALESCE($8, active)
        WHERE id = $1
        RETURNING id, active
      `,
      [id, dataSourceId, entityType, targetRef, businessName, description || null, owner || null, active]
    );

    if (updateResult.rowCount === 0) {
      return json(res, 404, { error: "not_found", message: "Semantic entity not found" });
    }
    triggerRagReindexAsync(dataSourceId);
    return json(res, 200, updateResult.rows[0]);
  }

  const insertResult = await appDb.query(
    `
      INSERT INTO semantic_entities (
        data_source_id,
        entity_type,
        target_ref,
        business_name,
        description,
        owner,
        active
      ) VALUES ($1, $2, $3, $4, $5, $6, COALESCE($7, TRUE))
      RETURNING id, active
    `,
    [dataSourceId, entityType, targetRef, businessName, description || null, owner || null, active]
  );

  triggerRagReindexAsync(dataSourceId);
  return json(res, 200, insertResult.rows[0]);
}

async function handleUpsertMetricDefinition(req, res) {
  const body = await readJsonBody(req);
  const { id, semantic_entity_id: semanticEntityId, sql_expression: sqlExpression, grain, filters_json: filtersJson } = body;

  if (!semanticEntityId || !sqlExpression) {
    return badRequest(res, "semantic_entity_id and sql_expression are required");
  }

  if (id) {
    const sourceResult = await appDb.query(
      `
        SELECT se.data_source_id
        FROM metric_definitions md
        JOIN semantic_entities se ON se.id = md.semantic_entity_id
        WHERE md.id = $1
      `,
      [id]
    );

    const updateResult = await appDb.query(
      `
        UPDATE metric_definitions
        SET
          semantic_entity_id = $2,
          sql_expression = $3,
          grain = $4,
          filters_json = $5
        WHERE id = $1
        RETURNING id
      `,
      [id, semanticEntityId, sqlExpression, grain || null, filtersJson || null]
    );

    if (updateResult.rowCount === 0) {
      return json(res, 404, { error: "not_found", message: "Metric definition not found" });
    }
    const dataSourceId = sourceResult.rows[0]?.data_source_id || null;
    triggerRagReindexAsync(dataSourceId);
    return json(res, 200, updateResult.rows[0]);
  }

  const sourceResult = await appDb.query(
    "SELECT data_source_id FROM semantic_entities WHERE id = $1",
    [semanticEntityId]
  );
  const dataSourceId = sourceResult.rows[0]?.data_source_id || null;

  const insertResult = await appDb.query(
    `
      INSERT INTO metric_definitions (semantic_entity_id, sql_expression, grain, filters_json)
      VALUES ($1, $2, $3, $4)
      RETURNING id
    `,
    [semanticEntityId, sqlExpression, grain || null, filtersJson || null]
  );

  triggerRagReindexAsync(dataSourceId);
  return json(res, 200, insertResult.rows[0]);
}

async function handleUpsertJoinPolicy(req, res) {
  const body = await readJsonBody(req);
  const {
    id,
    data_source_id: dataSourceId,
    left_ref: leftRef,
    right_ref: rightRef,
    join_type: joinType,
    on_clause: onClause,
    approved,
    notes
  } = body;

  if (!dataSourceId || !leftRef || !rightRef || !joinType || !onClause || typeof approved !== "boolean") {
    return badRequest(res, "data_source_id, left_ref, right_ref, join_type, on_clause, approved are required");
  }

  if (id) {
    const updateResult = await appDb.query(
      `
        UPDATE join_policies
        SET
          data_source_id = $2,
          left_ref = $3,
          right_ref = $4,
          join_type = $5,
          on_clause = $6,
          approved = $7,
          notes = $8
        WHERE id = $1
        RETURNING id
      `,
      [id, dataSourceId, leftRef, rightRef, joinType, onClause, approved, notes || null]
    );
    if (updateResult.rowCount === 0) {
      return json(res, 404, { error: "not_found", message: "Join policy not found" });
    }
    triggerRagReindexAsync(dataSourceId);
    return json(res, 200, updateResult.rows[0]);
  }

  const insertResult = await appDb.query(
    `
      INSERT INTO join_policies (
        data_source_id,
        left_ref,
        right_ref,
        join_type,
        on_clause,
        approved,
        notes
      ) VALUES ($1, $2, $3, $4, $5, $6, $7)
      RETURNING id
    `,
    [dataSourceId, leftRef, rightRef, joinType, onClause, approved, notes || null]
  );

  triggerRagReindexAsync(dataSourceId);
  return json(res, 200, insertResult.rows[0]);
}

async function handleCreateSession(req, res) {
  const body = await readJsonBody(req);
  const { data_source_id: dataSourceId, question } = body;

  if (!dataSourceId || !question) {
    return badRequest(res, "data_source_id and question are required");
  }

  const sourceResult = await appDb.query("SELECT id FROM data_sources WHERE id = $1", [dataSourceId]);
  if (sourceResult.rowCount === 0) {
    return json(res, 404, { error: "not_found", message: "Data source not found" });
  }

  const userId = req.headers["x-user-id"] || "anonymous";
  const sessionResult = await appDb.query(
    `
      INSERT INTO query_sessions (user_id, data_source_id, question, status)
      VALUES ($1, $2, $3, 'created')
      RETURNING id
    `,
    [userId, dataSourceId, question]
  );

  return json(res, 201, { session_id: sessionResult.rows[0].id, status: "created" });
}

async function handlePromptHistory(req, res, requestUrl) {
  const userId = req.headers["x-user-id"] || "anonymous";
  const dataSourceId = requestUrl.searchParams.get("data_source_id");
  const search = (requestUrl.searchParams.get("q") || "").trim();
  const requestedLimit = Number(requestUrl.searchParams.get("limit") || 20);
  const limit = clamp(Number.isFinite(requestedLimit) ? requestedLimit : 20, 1, 200);

  if (dataSourceId && !isUuid(dataSourceId)) {
    return badRequest(res, "data_source_id must be a valid UUID");
  }

  const result = await appDb.query(
    `
      SELECT
        qs.id,
        qs.question,
        qs.data_source_id,
        qs.created_at,
        qa.generated_sql AS latest_sql
      FROM query_sessions qs
      LEFT JOIN LATERAL (
        SELECT generated_sql
        FROM query_attempts
        WHERE session_id = qs.id
        ORDER BY created_at DESC
        LIMIT 1
      ) qa ON TRUE
      WHERE user_id = $1
        AND ($2::uuid IS NULL OR qs.data_source_id = $2::uuid)
        AND ($3::text = '' OR question ILIKE '%' || $3 || '%')
      ORDER BY qs.created_at DESC
      LIMIT $4
    `,
    [userId, dataSourceId, search, limit]
  );

  return json(res, 200, { items: result.rows });
}

async function ensureDataSourceExists(dataSourceId) {
  const sourceResult = await appDb.query("SELECT id FROM data_sources WHERE id = $1", [dataSourceId]);
  return sourceResult.rowCount > 0;
}

async function handleCreateSavedQuery(req, res) {
  const body = await readJsonBody(req);
  const ownerId = String(req.headers["x-user-id"] || "anonymous").trim() || "anonymous";
  const dataSourceId = String(body.data_source_id || "").trim();
  const name = typeof body.name === "string" ? body.name.trim() : "";
  const sql = typeof body.sql === "string" ? body.sql.trim() : "";
  const description = normalizeOptionalTrimmedString(body.description);
  const defaultRunParamsValidation = validateSavedQueryDefaultRunParams(body.default_run_params);

  if (!name || !dataSourceId || !sql) {
    return badRequest(res, "name, data_source_id and sql are required");
  }
  if (!isUuid(dataSourceId)) {
    return badRequest(res, "data_source_id must be a valid UUID");
  }
  if (name.length > SAVED_QUERY_NAME_MAX_LENGTH) {
    return badRequest(res, `name cannot exceed ${SAVED_QUERY_NAME_MAX_LENGTH} characters`);
  }
  if (description && description.length > SAVED_QUERY_DESCRIPTION_MAX_LENGTH) {
    return badRequest(res, `description cannot exceed ${SAVED_QUERY_DESCRIPTION_MAX_LENGTH} characters`);
  }
  if (!defaultRunParamsValidation.ok) {
    return badRequest(res, defaultRunParamsValidation.message);
  }

  if (!(await ensureDataSourceExists(dataSourceId))) {
    return json(res, 404, { error: "not_found", message: "Data source not found" });
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
          default_run_params
        ) VALUES ($1, $2, $3, $4, $5, $6::jsonb)
        RETURNING
          id,
          owner_id,
          name,
          description,
          data_source_id,
          sql,
          default_run_params,
          created_at,
          updated_at
      `,
      [ownerId, name, description, dataSourceId, sql, JSON.stringify(defaultRunParamsValidation.value)]
    );

    return json(res, 201, insertResult.rows[0]);
  } catch (err) {
    if (isPgUniqueViolation(err)) {
      return json(res, 409, {
        error: "conflict",
        message: "Saved query name already exists for this owner and data source"
      });
    }
    throw err;
  }
}

async function handleListSavedQueries(_req, res, requestUrl) {
  const dataSourceId = String(requestUrl.searchParams.get("data_source_id") || "").trim();
  if (dataSourceId && !isUuid(dataSourceId)) {
    return badRequest(res, "data_source_id must be a valid UUID");
  }

  const result = await appDb.query(
    `
      SELECT
        id,
        owner_id,
        name,
        description,
        data_source_id,
        sql,
        default_run_params,
        created_at,
        updated_at
      FROM saved_queries
      WHERE ($1::uuid IS NULL OR data_source_id = $1::uuid)
      ORDER BY updated_at DESC, created_at DESC
    `,
    [dataSourceId || null]
  );

  return json(res, 200, { items: result.rows });
}

async function handleGetSavedQuery(_req, res, savedQueryId) {
  if (!isUuid(savedQueryId)) {
    return badRequest(res, "savedQueryId must be a valid UUID");
  }

  const result = await appDb.query(
    `
      SELECT
        id,
        owner_id,
        name,
        description,
        data_source_id,
        sql,
        default_run_params,
        created_at,
        updated_at
      FROM saved_queries
      WHERE id = $1
    `,
    [savedQueryId]
  );

  if (result.rowCount === 0) {
    return json(res, 404, { error: "not_found", message: "Saved query not found" });
  }

  return json(res, 200, result.rows[0]);
}

async function handleUpdateSavedQuery(req, res, savedQueryId) {
  if (!isUuid(savedQueryId)) {
    return badRequest(res, "savedQueryId must be a valid UUID");
  }

  const body = await readJsonBody(req);
  const dataSourceId = String(body.data_source_id || "").trim();
  const name = typeof body.name === "string" ? body.name.trim() : "";
  const sql = typeof body.sql === "string" ? body.sql.trim() : "";
  const description = normalizeOptionalTrimmedString(body.description);
  const defaultRunParamsValidation = validateSavedQueryDefaultRunParams(body.default_run_params);

  if (!name || !dataSourceId || !sql) {
    return badRequest(res, "name, data_source_id and sql are required");
  }
  if (!isUuid(dataSourceId)) {
    return badRequest(res, "data_source_id must be a valid UUID");
  }
  if (name.length > SAVED_QUERY_NAME_MAX_LENGTH) {
    return badRequest(res, `name cannot exceed ${SAVED_QUERY_NAME_MAX_LENGTH} characters`);
  }
  if (description && description.length > SAVED_QUERY_DESCRIPTION_MAX_LENGTH) {
    return badRequest(res, `description cannot exceed ${SAVED_QUERY_DESCRIPTION_MAX_LENGTH} characters`);
  }
  if (!defaultRunParamsValidation.ok) {
    return badRequest(res, defaultRunParamsValidation.message);
  }

  if (!(await ensureDataSourceExists(dataSourceId))) {
    return json(res, 404, { error: "not_found", message: "Data source not found" });
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
          updated_at = NOW()
        WHERE id = $1
        RETURNING
          id,
          owner_id,
          name,
          description,
          data_source_id,
          sql,
          default_run_params,
          created_at,
          updated_at
      `,
      [savedQueryId, name, description, dataSourceId, sql, JSON.stringify(defaultRunParamsValidation.value)]
    );

    if (updateResult.rowCount === 0) {
      return json(res, 404, { error: "not_found", message: "Saved query not found" });
    }

    return json(res, 200, updateResult.rows[0]);
  } catch (err) {
    if (isPgUniqueViolation(err)) {
      return json(res, 409, {
        error: "conflict",
        message: "Saved query name already exists for this owner and data source"
      });
    }
    throw err;
  }
}

async function handleDeleteSavedQuery(_req, res, savedQueryId) {
  if (!isUuid(savedQueryId)) {
    return badRequest(res, "savedQueryId must be a valid UUID");
  }

  const deleteResult = await appDb.query(
    `
      DELETE FROM saved_queries
      WHERE id = $1
      RETURNING id
    `,
    [savedQueryId]
  );

  if (deleteResult.rowCount === 0) {
    return json(res, 404, { error: "not_found", message: "Saved query not found" });
  }

  return json(res, 200, { ok: true, id: deleteResult.rows[0].id });
}

async function handleRunSession(req, res, sessionId) {
  const body = await readJsonBody(req);
  const requestedProvider = body.llm_provider || null;
  const requestedModel = body.model || null;
  const noExecute = body.no_execute === true;
  const sqlOverride = typeof body.sql_override === "string" && body.sql_override.trim() ? body.sql_override.trim() : null;
  const maxRows = clamp(Number(body.max_rows || 1000), 1, 100000);
  const timeoutMs = clamp(Number(body.timeout_ms || 20000), 1000, 120000);

  if (requestedProvider && !LLM_PROVIDERS.has(requestedProvider)) {
    const providerResult = await appDb.query("SELECT 1 FROM llm_providers WHERE provider = $1", [requestedProvider]);
    if (providerResult.rowCount === 0) {
      return badRequest(res, "Unsupported llm_provider");
    }
  }

  const sessionResult = await appDb.query(
    `
      SELECT
        qs.id AS session_id,
        qs.question,
        qs.data_source_id,
        ds.connection_ref,
        ds.db_type
      FROM query_sessions qs
      JOIN data_sources ds ON ds.id = qs.data_source_id
      WHERE qs.id = $1
    `,
    [sessionId]
  );

  if (sessionResult.rowCount === 0) {
    return json(res, 404, { error: "not_found", message: "Session not found" });
  }

  const session = sessionResult.rows[0];
  if (!isSupportedDbType(session.db_type)) {
    return badRequest(res, `Unsupported db_type for execution: ${session.db_type}`);
  }
  const sqlDialect = session.db_type === "mssql" ? "mssql" : "postgres";

  const schemaObjectsResult = await appDb.query(
    `
      SELECT id, schema_name, object_name, object_type
      FROM schema_objects
      WHERE data_source_id = $1
        AND is_ignored = FALSE
        AND object_type IN ('table', 'view', 'materialized_view')
      ORDER BY schema_name, object_name
    `,
    [session.data_source_id]
  );

  const columnsResult = await appDb.query(
    `
      SELECT
        so.schema_name,
        so.object_name,
        c.column_name,
        c.data_type
      FROM columns c
      JOIN schema_objects so ON so.id = c.schema_object_id
      WHERE so.data_source_id = $1
        AND so.is_ignored = FALSE
      ORDER BY so.schema_name, so.object_name, c.ordinal_position
    `,
    [session.data_source_id]
  );

  const semanticEntitiesResult = await appDb.query(
    `
      SELECT id, entity_type, target_ref, business_name
      FROM semantic_entities
      WHERE data_source_id = $1 AND active = TRUE
      ORDER BY business_name
    `,
    [session.data_source_id]
  );

  const metricDefinitionsResult = await appDb.query(
    `
      SELECT
        md.id,
        md.semantic_entity_id,
        md.sql_expression,
        md.grain,
        se.business_name
      FROM metric_definitions md
      JOIN semantic_entities se ON se.id = md.semantic_entity_id
      WHERE se.data_source_id = $1 AND se.active = TRUE
      ORDER BY se.business_name
    `,
    [session.data_source_id]
  );

  const joinPoliciesResult = await appDb.query(
    `
      SELECT id, left_ref, right_ref, join_type, on_clause
      FROM join_policies
      WHERE data_source_id = $1 AND approved = TRUE
      ORDER BY left_ref, right_ref
    `,
    [session.data_source_id]
  );

  const ragNotesResult = await appDb.query(
    `
      SELECT id, title, content
      FROM rag_notes
      WHERE data_source_id = $1 AND active = TRUE
      ORDER BY created_at DESC
    `,
    [session.data_source_id]
  );

  const ragDocuments = await retrieveRagContext(session.data_source_id, session.question, { limit: 12 });
  const forbiddenColumns = extractForbiddenColumnsFromRagNotes(ragNotesResult.rows, columnsResult.rows);

  let generatedSql;
  let usedProvider = "unknown";
  let usedModel = requestedModel || "unknown";
  let generationAttempts = [];
  let generationTokenUsage = null;
  let promptVersion = "v2-llm-router";
  if (sqlOverride) {
    generatedSql = sqlOverride;
    usedProvider = "cached_history";
    usedModel = "n/a";
    promptVersion = "v2-cached-sql";
  } else {
    try {
      const generation = await generateSqlWithRouting({
        requestId: req.requestId || null,
        dataSourceId: session.data_source_id,
        dialect: sqlDialect,
        question: session.question,
        maxRows,
        requestedProvider,
        requestedModel,
        schemaObjects: schemaObjectsResult.rows,
        columns: columnsResult.rows,
        semanticEntities: semanticEntitiesResult.rows,
        metricDefinitions: metricDefinitionsResult.rows,
        joinPolicies: joinPoliciesResult.rows,
        ragDocuments
      });

      generatedSql = generation.sql;
      usedProvider = generation.provider;
      usedModel = generation.model || usedModel;
      generationAttempts = generation.attempts || [];
      generationTokenUsage = generation.tokenUsage || null;
      promptVersion = generation.promptVersion || promptVersion;
    } catch (err) {
      await appDb.query("UPDATE query_sessions SET status = 'failed' WHERE id = $1", [sessionId]);
      return json(res, 502, { error: "llm_generation_failed", message: err.message });
    }
  }

  const generationStartedAt = Date.now();
  let adapter = null;

  try {
    const safety = validateAndNormalizeSql(generatedSql, {
      maxRows,
      schemaObjects: schemaObjectsResult.rows,
      dialect: sqlDialect
    });

    let validationErrors = [];
    let safeSql = generatedSql;

    if (!safety.ok) {
      validationErrors = safety.errors;
    } else {
      safeSql = safety.sql;
      const blockedColumnCheck = validateSqlAgainstForbiddenColumns(
        safeSql,
        forbiddenColumns,
        safety.refs || [],
        sqlDialect
      );
      if (!blockedColumnCheck.ok) {
        validationErrors = blockedColumnCheck.errors;
      }

      if (!noExecute) {
        try {
          adapter = createDatabaseAdapter(session.db_type, session.connection_ref);
        } catch (err) {
          return badRequest(res, err.message);
        }

        const adapterValidation = await adapter.validateSql(safeSql);
        if (validationErrors.length === 0 && !adapterValidation.ok) {
          validationErrors = adapterValidation.errors;
        }
      }
    }

    const validationJson = {
      ok: validationErrors.length === 0,
      errors: validationErrors,
      references: safety.refs || [],
      provider_attempts: generationAttempts,
      execution: {
        skipped: noExecute,
        reason: noExecute ? "no_execute" : null
      },
      trace: {
        request_id: req.requestId || null
      }
    };

    if (validationErrors.length > 0) {
      await appDb.query(
        `
          INSERT INTO query_attempts (
            session_id,
            llm_provider,
            model,
            prompt_version,
            generated_sql,
            validation_result_json,
            latency_ms,
            token_usage_json
          ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
        `,
        [
          sessionId,
          usedProvider,
          usedModel,
          promptVersion,
          generatedSql,
          validationJson,
          Date.now() - generationStartedAt,
          generationTokenUsage
        ]
      );

      await appDb.query("UPDATE query_sessions SET status = 'failed' WHERE id = $1", [sessionId]);
      return json(res, 400, { error: "invalid_sql", details: validationErrors, sql: generatedSql });
    }

    if (!noExecute && EXPLAIN_BUDGET_ENABLED && sqlDialect === "postgres") {
      const explainRows = await adapter.explain(safeSql);
      const budget = evaluateExplainBudget(explainRows, {
        maxTotalCost: EXPLAIN_MAX_TOTAL_COST,
        maxPlanRows: EXPLAIN_MAX_PLAN_ROWS
      });

      validationJson.explain_budget = budget;
      if (!budget.ok) {
        await appDb.query(
          `
          INSERT INTO query_attempts (
            session_id,
            llm_provider,
            model,
            prompt_version,
            generated_sql,
            validation_result_json,
            latency_ms,
            token_usage_json
          ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
        `,
          [
            sessionId,
            usedProvider,
            usedModel,
            promptVersion,
            safeSql,
            validationJson,
            Date.now() - generationStartedAt,
            generationTokenUsage
          ]
        );

        await appDb.query("UPDATE query_sessions SET status = 'failed' WHERE id = $1", [sessionId]);
        return json(res, 400, {
          error: "query_budget_exceeded",
          details: budget.errors,
          metrics: budget.metrics,
          sql: safeSql
        });
      }
    }

    const citations = buildCitations({
      question: session.question,
      sql: safeSql,
      refs: safety.refs || [],
      schemaObjects: schemaObjectsResult.rows,
      semanticEntities: semanticEntitiesResult.rows,
      metricDefinitions: metricDefinitionsResult.rows,
      joinPolicies: joinPoliciesResult.rows
    });
    citations.rag_documents = ragDocuments.map((doc) => ({
      id: doc.id,
      doc_type: doc.doc_type,
      ref_id: doc.ref_id,
      score: Number(doc.score || 0),
      rerank_score: Number(doc.rerank_score || 0),
      embedding_model: doc.embedding_model || null
    }));
    const confidence = computeConfidence({
      provider: usedProvider,
      attempts: generationAttempts,
      citations
    });

    validationJson.citations = citations;
    validationJson.confidence = confidence;
    const attemptResult = await appDb.query(
      `
        INSERT INTO query_attempts (
          session_id,
          llm_provider,
          model,
          prompt_version,
          generated_sql,
          validation_result_json,
          latency_ms,
          token_usage_json
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
        RETURNING id
      `,
      [
        sessionId,
        usedProvider,
        usedModel,
        promptVersion,
        safeSql,
        validationJson,
        Date.now() - generationStartedAt,
        generationTokenUsage
      ]
    );

    const attemptId = attemptResult.rows[0].id;
    if (noExecute) {
      await appDb.query("UPDATE query_sessions SET status = 'completed' WHERE id = $1", [sessionId]);

      return json(res, 200, {
        attempt_id: attemptId,
        sql: safeSql,
        columns: [],
        rows: [],
        row_count: 0,
        duration_ms: 0,
        confidence,
        preview: true,
        provider: {
          name: usedProvider,
          model: usedModel
        },
        citations
      });
    }

    const execution = await adapter.executeReadOnly(safeSql, { timeoutMs, maxRows });
    await appDb.query(
      `
        INSERT INTO query_results_meta (
          attempt_id,
          row_count,
          duration_ms,
          bytes_scanned,
          truncated
        ) VALUES ($1, $2, $3, NULL, $4)
      `,
      [attemptId, execution.rowCount, execution.durationMs, execution.truncated]
    );

    await appDb.query("UPDATE query_sessions SET status = 'completed' WHERE id = $1", [sessionId]);

    return json(res, 200, {
      attempt_id: attemptId,
      sql: safeSql,
      columns: execution.columns,
      rows: execution.rows,
      row_count: execution.rowCount,
      duration_ms: execution.durationMs,
      confidence,
      preview: false,
      provider: {
        name: usedProvider,
        model: usedModel
      },
      citations
    });
  } catch (err) {
    await appDb.query("UPDATE query_sessions SET status = 'failed' WHERE id = $1", [sessionId]);
    if (isLikelyInvalidSqlExecutionError(err, sqlDialect)) {
      return json(res, 400, {
        error: "invalid_sql",
        details: [err.message],
        sql: generatedSql
      });
    }
    return json(res, 500, {
      error: "query_execution_failed",
      message: err.message,
      sql: generatedSql
    });
  } finally {
    if (adapter) {
      await adapter.close();
    }
  }
}

async function handleFeedback(req, res, sessionId) {
  const body = await readJsonBody(req);
  const { rating, corrected_sql: correctedSql, comment } = body;

  if (!Number.isInteger(rating) || rating < 1 || rating > 5) {
    return badRequest(res, "rating must be an integer between 1 and 5");
  }

  const sessionResult = await appDb.query(
    `
      SELECT
        qs.id,
        qs.data_source_id,
        qs.question,
        ds.db_type
      FROM query_sessions qs
      JOIN data_sources ds ON ds.id = qs.data_source_id
      WHERE qs.id = $1
    `,
    [sessionId]
  );
  if (sessionResult.rowCount === 0) {
    return json(res, 404, { error: "not_found", message: "Session not found" });
  }
  const session = sessionResult.rows[0];

  await appDb.query(
    `
      INSERT INTO user_feedback (session_id, rating, corrected_sql, comment)
      VALUES ($1, $2, $3, $4)
    `,
    [sessionId, rating, correctedSql || null, comment || null]
  );

  let exampleSaved = false;
  let exampleReason = null;

  if (correctedSql && String(correctedSql).trim()) {
    const schemaObjectsResult = await appDb.query(
      `
        SELECT schema_name, object_name
        FROM schema_objects
        WHERE data_source_id = $1
          AND is_ignored = FALSE
      `,
      [session.data_source_id]
    );

    const normalized = validateAndNormalizeSql(correctedSql, {
      maxRows: 1000,
      schemaObjects: schemaObjectsResult.rows,
      dialect: session.db_type === "mssql" ? "mssql" : "postgres"
    });

    if (!normalized.ok) {
      exampleReason = `corrected_sql_not_saved: ${normalized.errors.join("; ")}`;
    } else {
      await appDb.query(
        `
          INSERT INTO nl_sql_examples (
            data_source_id,
            question,
            sql,
            quality_score,
            source
          ) VALUES ($1, $2, $3, $4, 'feedback')
        `,
        [session.data_source_id, session.question, normalized.sql, rating / 5]
      );
      exampleSaved = true;
      triggerRagReindexAsync(session.data_source_id);
    }
  }

  return json(res, 200, { ok: true, example_saved: exampleSaved, example_reason: exampleReason });
}


async function handleExportSession(req, res, sessionId) {
  const body = await readJsonBody(req).catch(() => ({})); // Body optional
  const requestUrl = new URL(req.url, "http://localhost");
  const format = body.format || requestUrl.searchParams.get("format") || "json";

  if (!SUPPORTED_FORMATS.has(format)) {
    return badRequest(res, `Unsupported format: ${format}`);
  }

  try {
    const { buffer, contentType, filename } = await exportQueryResult(sessionId, format);
    res.writeHead(200, {
      "Content-Type": contentType,
      "Content-Disposition": `attachment; filename="${filename}"`,
      "Content-Length": buffer.length
    });
    res.end(buffer);
  } catch (err) {
    if (err.message === "Session not found" || err.message === "No successful query attempts found for this session") {
      return json(res, 404, { error: "not_found", message: err.message });
    }
    console.error("[export] failed:", err);
    return internalError(res);
  }
}

async function handleExportDeliver(req, res, sessionId) {
  const body = await readJsonBody(req);
  const { delivery_mode: deliveryMode, format = "json", recipients } = body;

  if (!deliveryMode || !["download", "email"].includes(deliveryMode)) {
    return badRequest(res, "delivery_mode must be 'download' or 'email'");
  }

  const sessionResult = await appDb.query("SELECT id FROM query_sessions WHERE id = $1", [sessionId]);
  if (sessionResult.rowCount === 0) {
    return json(res, 404, { error: "not_found", message: "Session not found" });
  }

  const requestedBy = req.headers["x-user-id"] || "anonymous";

  try {
    const delivery = await createDelivery({ sessionId, deliveryMode, format, recipients, requestedBy });

    if (deliveryMode === "download") {
      res.writeHead(200, {
        "Content-Type": delivery.contentType,
        "Content-Disposition": `attachment; filename="${delivery.filename}"`,
        "Content-Length": delivery.buffer.length,
        "x-export-id": delivery.id
      });
      return res.end(delivery.buffer);
    }

    // Email mode: return accepted with tracking ID
    return json(res, 202, {
      export_id: delivery.id,
      status: delivery.status,
      delivery_mode: delivery.delivery_mode
    });
  } catch (err) {
    if (err.statusCode === 400) {
      return badRequest(res, err.message);
    }
    if (err.message === "Session not found" || err.message === "No successful query attempts found for this session") {
      return json(res, 404, { error: "not_found", message: err.message });
    }
    console.error("[export/deliver] failed:", err);
    return internalError(res);
  }
}

async function handleExportStatus(_req, res, exportId) {
  const delivery = await getDeliveryStatus(exportId);
  if (!delivery) {
    return json(res, 404, { error: "not_found", message: "Export delivery not found" });
  }
  return json(res, 200, delivery);
}

async function handleProviderList(_req, res) {
  const result = await appDb.query(
    `SELECT id, provider, default_model, base_url, display_name, enabled, created_at, updated_at
     FROM llm_providers
     ORDER BY provider`
  );
  return json(res, 200, { items: result.rows });
}

async function handleProviderUpsert(req, res) {
  const body = await readJsonBody(req);
  const provider = typeof body.provider === "string" ? body.provider.trim() : "";

  const existingResult = await appDb.query(
    `
      SELECT api_key_ref, base_url, display_name
      FROM llm_providers
      WHERE provider = $1
    `,
    [provider]
  );
  const existingProvider = existingResult.rows[0] || null;
  const normalized = normalizeProviderUpsertInput(body, existingProvider, LLM_PROVIDERS);

  const result = await appDb.query(
    `
      INSERT INTO llm_providers (provider, api_key_ref, default_model, base_url, display_name, enabled, updated_at)
      VALUES ($1, $2, $3, $4, $5, $6, NOW())
      ON CONFLICT (provider)
      DO UPDATE SET
        api_key_ref = EXCLUDED.api_key_ref,
        default_model = EXCLUDED.default_model,
        base_url = EXCLUDED.base_url,
        display_name = EXCLUDED.display_name,
        enabled = EXCLUDED.enabled,
        updated_at = NOW()
      RETURNING provider, base_url, display_name, enabled
    `,
    [
      normalized.provider,
      normalized.apiKeyRef,
      normalized.defaultModel,
      normalized.baseUrl,
      normalized.displayName,
      normalized.enabled
    ]
  );

  return json(res, 200, result.rows[0]);
}

async function handleRoutingRuleUpsert(req, res) {
  const body = await readJsonBody(req);
  const {
    data_source_id: dataSourceId,
    primary_provider: primaryProvider,
    fallback_providers: fallbackProviders,
    strategy
  } = body;

  if (!dataSourceId || !primaryProvider || !Array.isArray(fallbackProviders) || !strategy) {
    return badRequest(res, "data_source_id, primary_provider, fallback_providers, strategy are required");
  }

  const supportedProviders = await loadSupportedProviderSet();

  if (!supportedProviders.has(primaryProvider)) {
    return badRequest(res, "Invalid primary_provider");
  }

  if (!ROUTING_STRATEGIES.has(strategy)) {
    return badRequest(res, "Invalid strategy");
  }

  const invalidFallback = fallbackProviders.find((provider) => !supportedProviders.has(provider));
  if (invalidFallback) {
    return badRequest(res, `Invalid fallback provider: ${invalidFallback}`);
  }

  const dataSourceResult = await appDb.query("SELECT id FROM data_sources WHERE id = $1", [dataSourceId]);
  if (dataSourceResult.rowCount === 0) {
    return json(res, 404, { error: "not_found", message: "Data source not found" });
  }

  const result = await appDb.query(
    `
      INSERT INTO llm_routing_rules (
        data_source_id,
        primary_provider,
        fallback_providers,
        strategy,
        updated_at
      ) VALUES ($1, $2, $3, $4, NOW())
      ON CONFLICT (data_source_id)
      DO UPDATE SET
        primary_provider = EXCLUDED.primary_provider,
        fallback_providers = EXCLUDED.fallback_providers,
        strategy = EXCLUDED.strategy,
        updated_at = NOW()
      RETURNING id
    `,
    [dataSourceId, primaryProvider, fallbackProviders, strategy]
  );

  return json(res, 200, result.rows[0]);
}

async function handleProviderHealth(_req, res) {
  const result = await appDb.query(
    `
      SELECT provider, api_key_ref, default_model, base_url, enabled
      FROM llm_providers
      ORDER BY provider
    `
  );

  const checkedAt = new Date().toISOString();
  const items = [];

  for (const row of result.rows) {
    if (!row.enabled) {
      items.push({
        provider: row.provider,
        status: "down",
        checked_at: checkedAt
      });
      continue;
    }

    try {
      const adapter = buildHealthAdapter(row.provider, row.api_key_ref, row.default_model, row.base_url);
      await adapter.healthCheck();
      items.push({
        provider: row.provider,
        status: "healthy",
        checked_at: checkedAt
      });
    } catch (err) {
      items.push({
        provider: row.provider,
        status: "degraded",
        checked_at: checkedAt,
        reason: err.message
      });
    }
  }

  return json(res, 200, { items });
}

async function handleObservabilityMetrics(req, res, requestUrl) {
  const windowHours = Number(requestUrl.searchParams.get("window_hours") || 24);
  const metrics = await buildObservabilityMetrics({ windowHours });
  return json(res, 200, metrics);
}

async function handleReleaseGates(_req, res) {
  const payload = await loadLatestBenchmarkReleaseGates();
  if (!payload.found) {
    return json(res, 404, {
      error: "not_found",
      message: payload.message
    });
  }
  return json(res, 200, payload);
}

async function handleBenchmarkCommand(_req, res) {
  const payload = buildBenchmarkCommand();
  return json(res, 200, payload);
}

async function handleCreateBenchmarkReport(req, res) {
  const body = await readJsonBody(req);
  const {
    run_date: runDate,
    dataset_file: datasetFile,
    data_source_id: dataSourceId,
    provider,
    model,
    summary
  } = body;

  if (!runDate || !datasetFile || !summary || typeof summary !== "object") {
    return badRequest(res, "run_date, dataset_file and summary are required");
  }

  const inserted = await appDb.query(
    `
      INSERT INTO benchmark_reports (
        run_date,
        dataset_file,
        data_source_id,
        provider,
        model,
        summary_json,
        report_json
      ) VALUES ($1, $2, $3, $4, $5, $6, $7)
      RETURNING id, created_at
    `,
    [runDate, datasetFile, dataSourceId || null, provider || null, model || null, summary, body]
  );

  return json(res, 201, inserted.rows[0]);
}

async function handleRagReindex(req, res, requestUrl) {
  const dataSourceId = requestUrl.searchParams.get("data_source_id");
  if (!dataSourceId) {
    return badRequest(res, "data_source_id query parameter is required");
  }
  if (!isUuid(dataSourceId)) {
    return badRequest(res, "data_source_id must be a valid UUID");
  }

  const sourceResult = await appDb.query("SELECT id FROM data_sources WHERE id = $1", [dataSourceId]);
  if (sourceResult.rowCount === 0) {
    return json(res, 404, { error: "not_found", message: "Data source not found" });
  }

  const result = await reindexRagDocuments(dataSourceId);
  return json(res, 202, {
    job_id: "inline-reindex",
    status: "succeeded",
    ...result
  });
}

function buildHealthAdapter(provider, apiKeyRef, defaultModel, baseUrl) {
  if (provider === "openai") {
    return new OpenAiAdapter({
      apiKey: resolveApiKey(apiKeyRef, "OPENAI_API_KEY"),
      defaultModel
    });
  }
  if (provider === "gemini") {
    return new GeminiAdapter({
      apiKey: resolveApiKey(apiKeyRef, "GEMINI_API_KEY"),
      defaultModel
    });
  }
  if (provider === "deepseek") {
    return new DeepSeekAdapter({
      apiKey: resolveApiKey(apiKeyRef, "DEEPSEEK_API_KEY"),
      defaultModel
    });
  }
  if (provider === "openrouter") {
    return new OpenRouterAdapter({
      apiKey: resolveApiKey(apiKeyRef, "OPENROUTER_API_KEY"),
      defaultModel
    });
  }
  if (baseUrl) {
    return new CustomAdapter({
      provider,
      apiKey: resolveApiKey(apiKeyRef, null),
      defaultModel,
      baseUrl
    });
  }
  throw new Error(`Unsupported provider: ${provider}`);
}

async function loadSupportedProviderSet() {
  const result = await appDb.query("SELECT provider FROM llm_providers");
  const providers = new Set(LLM_PROVIDERS);
  for (const row of result.rows) {
    if (row.provider) {
      providers.add(row.provider);
    }
  }
  return providers;
}

async function routeRequest(req, res) {
  const requestUrl = new URL(req.url, "http://localhost");
  const { pathname } = requestUrl;

  if (req.method === "GET" && pathname === "/health") {
    return json(res, 200, { status: "ok" });
  }

  if (req.method === "GET" && pathname === "/ready") {
    const db = await checkDatabase();
    if (db.ok) {
      return json(res, 200, { status: "ready" });
    }
    return json(res, 503, { status: "not_ready", reason: db.error });
  }

  if (req.method === "GET" && pathname === "/") {
    if (serveFrontendIndex(res)) {
      return;
    }

    return json(res, 200, {
      service: "report-pilot",
      status: "running",
      endpoints: ["/health", "/ready", "/docs", "/openapi.yaml", "/v1/*"]
    });
  }

  if (req.method === "GET" && (pathname === "/docs" || pathname === "/docs/")) {
    return serveSwaggerDocs(res);
  }

  if (req.method === "GET" && pathname === "/openapi.yaml") {
    return serveOpenApiSpec(res);
  }

  if (req.method === "GET" && serveFrontendAsset(res, pathname)) {
    return;
  }

  if (req.method === "POST" && pathname === "/v1/data-sources") {
    return handleCreateDataSource(req, res);
  }

  if (req.method === "GET" && pathname === "/v1/data-sources") {
    return handleListDataSources(req, res);
  }

  const deleteDataSourceMatch = pathname.match(/^\/v1\/data-sources\/([^/]+)$/);
  if (req.method === "DELETE" && deleteDataSourceMatch) {
    return handleDeleteDataSource(req, res, deleteDataSourceMatch[1]);
  }

  const introspectMatch = pathname.match(/^\/v1\/data-sources\/([^/]+)\/introspect$/);
  if (req.method === "POST" && introspectMatch) {
    return handleIntrospect(req, res, introspectMatch[1]);
  }

  const importSchemaMatch = pathname.match(/^\/v1\/data-sources\/([^/]+)\/import-schema$/);
  if (req.method === "POST" && importSchemaMatch) {
    return handleImportSchema(req, res, importSchemaMatch[1]);
  }

  if (req.method === "POST" && pathname === "/v1/data-sources/import") {
    return handleImportDataSource(req, res);
  }

  const exportDataSourceMatch = pathname.match(/^\/v1\/data-sources\/([^/]+)\/export$/);
  if (req.method === "GET" && exportDataSourceMatch) {
    return handleExportDataSource(req, res, exportDataSourceMatch[1]);
  }

  if (req.method === "GET" && pathname === "/v1/schema-objects") {
    return handleListSchemaObjects(req, res, requestUrl);
  }

  const schemaObjectMatch = pathname.match(/^\/v1\/schema-objects\/([^/]+)$/);
  if (req.method === "PATCH" && schemaObjectMatch) {
    return handlePatchSchemaObject(req, res, schemaObjectMatch[1]);
  }

  if (req.method === "POST" && pathname === "/v1/semantic-entities") {
    return handleUpsertSemanticEntity(req, res);
  }

  if (req.method === "POST" && pathname === "/v1/metric-definitions") {
    return handleUpsertMetricDefinition(req, res);
  }

  if (req.method === "POST" && pathname === "/v1/join-policies") {
    return handleUpsertJoinPolicy(req, res);
  }

  if (req.method === "POST" && pathname === "/v1/query/sessions") {
    return handleCreateSession(req, res);
  }

  if (req.method === "GET" && pathname === "/v1/query/prompts/history") {
    return handlePromptHistory(req, res, requestUrl);
  }

  if (req.method === "POST" && pathname === "/v1/saved-queries") {
    return handleCreateSavedQuery(req, res);
  }

  if (req.method === "GET" && pathname === "/v1/saved-queries") {
    return handleListSavedQueries(req, res, requestUrl);
  }

  const savedQueryMatch = pathname.match(/^\/v1\/saved-queries\/([^/]+)$/);
  if (req.method === "GET" && savedQueryMatch) {
    return handleGetSavedQuery(req, res, savedQueryMatch[1]);
  }

  if (req.method === "PUT" && savedQueryMatch) {
    return handleUpdateSavedQuery(req, res, savedQueryMatch[1]);
  }

  if (req.method === "DELETE" && savedQueryMatch) {
    return handleDeleteSavedQuery(req, res, savedQueryMatch[1]);
  }

  const runMatch = pathname.match(/^\/v1\/query\/sessions\/([^/]+)\/run$/);
  if (req.method === "POST" && runMatch) {
    return handleRunSession(req, res, runMatch[1]);
  }

  const feedbackMatch = pathname.match(/^\/v1\/query\/sessions\/([^/]+)\/feedback$/);
  if (req.method === "POST" && feedbackMatch) {
    return handleFeedback(req, res, feedbackMatch[1]);
  }

  const exportMatch = pathname.match(/^\/v1\/query\/sessions\/([^/]+)\/export$/);
  if (req.method === "POST" && exportMatch) {
    return handleExportSession(req, res, exportMatch[1]);
  }

  const deliverMatch = pathname.match(/^\/v1\/query\/sessions\/([^/]+)\/export\/deliver$/);
  if (req.method === "POST" && deliverMatch) {
    return handleExportDeliver(req, res, deliverMatch[1]);
  }

  const exportStatusMatch = pathname.match(/^\/v1\/exports\/([^/]+)\/status$/);
  if (req.method === "GET" && exportStatusMatch) {
    return handleExportStatus(req, res, exportStatusMatch[1]);
  }

  if (req.method === "GET" && pathname === "/v1/llm/providers") {
    return handleProviderList(req, res);
  }

  if (req.method === "POST" && pathname === "/v1/llm/providers") {
    return handleProviderUpsert(req, res);
  }

  if (req.method === "POST" && pathname === "/v1/llm/routing-rules") {
    return handleRoutingRuleUpsert(req, res);
  }

  if (req.method === "GET" && pathname === "/v1/health/providers") {
    return handleProviderHealth(req, res);
  }

  if (req.method === "GET" && pathname === "/v1/observability/metrics") {
    return handleObservabilityMetrics(req, res, requestUrl);
  }

  if (req.method === "GET" && pathname === "/v1/observability/release-gates") {
    return handleReleaseGates(req, res);
  }

  if (req.method === "GET" && pathname === "/v1/observability/benchmark-command") {
    return handleBenchmarkCommand(req, res);
  }

  if (req.method === "POST" && pathname === "/v1/observability/release-gates/report") {
    return handleCreateBenchmarkReport(req, res);
  }

  if (req.method === "GET" && pathname === "/v1/rag/notes") {
    return handleListRagNotes(req, res, requestUrl);
  }

  if (req.method === "POST" && pathname === "/v1/rag/notes") {
    return handleUpsertRagNote(req, res);
  }

  const ragNoteDeleteMatch = pathname.match(/^\/v1\/rag\/notes\/([^/]+)$/);
  if (req.method === "DELETE" && ragNoteDeleteMatch) {
    return handleDeleteRagNote(req, res, ragNoteDeleteMatch[1]);
  }

  if (req.method === "POST" && pathname === "/v1/rag/reindex") {
    return handleRagReindex(req, res, requestUrl);
  }

  if (shouldServeFrontendApp(req, pathname)) {
    return serveFrontendIndex(res);
  }

  return notFound(res);
}

function startServer() {
  const server = http.createServer(async (req, res) => {
    const startedAt = Date.now();
    const requestId = createRequestId();
    req.requestId = requestId;
    res.setHeader("x-request-id", requestId);

    // CORS
    const origin = req.headers.origin || "*";
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Access-Control-Allow-Credentials", "true");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, PATCH, DELETE, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, x-user-id");
    res.setHeader("Vary", "Origin");

    if (req.method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }

    res.on("finish", () => {
      logEvent("http_request", {
        request_id: requestId,
        method: req.method,
        path: req.url,
        status_code: res.statusCode,
        duration_ms: Date.now() - startedAt
      });
    });

    try {
      await routeRequest(req, res);
    } catch (err) {
      if (err.statusCode === 400) {
        return badRequest(res, err.message);
      }
      logEvent(
        "http_error",
        {
          request_id: requestId,
          method: req.method,
          path: req.url,
          error: err.message,
          stack: err.stack || null
        },
        "error"
      );
      return internalError(res);
    }
  });

  return new Promise((resolve, reject) => {
    server.on("error", reject);
    server.listen(PORT, () => {
      logEvent("server_started", { port: PORT });
      resolve(server);
    });
  });
}

module.exports = { startServer };
