const fs = require("fs");
const path = require("path");
const http = require("http");
const appDb = require("./lib/appDb");
const { createDatabaseAdapter, isSupportedDbType } = require("./adapters/dbAdapterFactory");
const { runIntrospection } = require("./services/introspectionService");
const { generateSqlWithRouting } = require("./services/llmSqlService");
const { validateAndNormalizeSql } = require("./services/sqlSafety");
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
const { resolveApiKey } = require("./adapters/llm/httpClient");
const { createRequestId, logEvent } = require("./lib/observability");
const { json, notFound, badRequest, internalError, readJsonBody } = require("./lib/http");

const PORT = Number(process.env.PORT || 8080);

const LLM_PROVIDERS = new Set(["openai", "gemini", "deepseek"]);
const ENTITY_TYPES = new Set(["table", "column", "metric", "dimension", "rule"]);
const ROUTING_STRATEGIES = new Set(["ordered_fallback", "cost_optimized", "latency_optimized"]);
const EXPLAIN_BUDGET_ENABLED = String(process.env.EXPLAIN_BUDGET_ENABLED || "true") === "true";
const EXPLAIN_MAX_TOTAL_COST = Number(process.env.EXPLAIN_MAX_TOTAL_COST || 500000);
const EXPLAIN_MAX_PLAN_ROWS = Number(process.env.EXPLAIN_MAX_PLAN_ROWS || 1000000);
const OPENAPI_SPEC_PATH = path.resolve(__dirname, "../../docs/api/openapi.yaml");

let cachedOpenApiSpec = null;

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

async function handleListSchemaObjects(req, res, requestUrl) {
  const dataSourceId = requestUrl.searchParams.get("data_source_id");
  if (!dataSourceId) {
    return badRequest(res, "data_source_id query parameter is required");
  }

  const result = await appDb.query(
    `
      SELECT id, object_type, schema_name, object_name, description
      FROM schema_objects
      WHERE data_source_id = $1
      ORDER BY schema_name, object_name
    `,
    [dataSourceId]
  );

  return json(res, 200, { items: result.rows });
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

async function handleRunSession(req, res, sessionId) {
  const body = await readJsonBody(req);
  const requestedProvider = body.llm_provider || null;
  const requestedModel = body.model || null;
  const sqlOverride = typeof body.sql_override === "string" && body.sql_override.trim() ? body.sql_override.trim() : null;
  const maxRows = clamp(Number(body.max_rows || 1000), 1, 100000);
  const timeoutMs = clamp(Number(body.timeout_ms || 20000), 1000, 120000);

  if (requestedProvider && !LLM_PROVIDERS.has(requestedProvider)) {
    return badRequest(res, "Unsupported llm_provider");
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
      WHERE data_source_id = $1 AND object_type IN ('table', 'view', 'materialized_view')
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

  const ragDocuments = await retrieveRagContext(session.data_source_id, session.question, { limit: 12 });

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

  let adapter;
  try {
    adapter = createDatabaseAdapter(session.db_type, session.connection_ref);
  } catch (err) {
    return badRequest(res, err.message);
  }
  const generationStartedAt = Date.now();

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
      const adapterValidation = await adapter.validateSql(safeSql);
      if (!adapterValidation.ok) {
        validationErrors = adapterValidation.errors;
      }
    }

    const validationJson = {
      ok: validationErrors.length === 0,
      errors: validationErrors,
      references: safety.refs || [],
      provider_attempts: generationAttempts,
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

    if (EXPLAIN_BUDGET_ENABLED && sqlDialect === "postgres") {
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

    const execution = await adapter.executeReadOnly(safeSql, { timeoutMs, maxRows });
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
      provider: {
        name: usedProvider,
        model: usedModel
      },
      citations
    });
  } catch (err) {
    await appDb.query("UPDATE query_sessions SET status = 'failed' WHERE id = $1", [sessionId]);
    return json(res, 500, {
      error: "query_execution_failed",
      message: err.message,
      sql: generatedSql
    });
  } finally {
    await adapter.close();
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
    `SELECT id, provider, default_model, enabled, created_at, updated_at
     FROM llm_providers
     ORDER BY provider`
  );
  return json(res, 200, { items: result.rows });
}

async function handleProviderUpsert(req, res) {
  const body = await readJsonBody(req);
  const { provider, api_key_ref: apiKeyRef, default_model: defaultModel, enabled } = body;
  if (!provider || !apiKeyRef || !defaultModel || typeof enabled !== "boolean") {
    return badRequest(res, "provider, api_key_ref, default_model, enabled are required");
  }

  if (!LLM_PROVIDERS.has(provider)) {
    return badRequest(res, "Invalid provider");
  }

  const result = await appDb.query(
    `
      INSERT INTO llm_providers (provider, api_key_ref, default_model, enabled, updated_at)
      VALUES ($1, $2, $3, $4, NOW())
      ON CONFLICT (provider)
      DO UPDATE SET
        api_key_ref = EXCLUDED.api_key_ref,
        default_model = EXCLUDED.default_model,
        enabled = EXCLUDED.enabled,
        updated_at = NOW()
      RETURNING provider, enabled
    `,
    [provider, apiKeyRef, defaultModel, enabled]
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

  if (!LLM_PROVIDERS.has(primaryProvider)) {
    return badRequest(res, "Invalid primary_provider");
  }

  if (!ROUTING_STRATEGIES.has(strategy)) {
    return badRequest(res, "Invalid strategy");
  }

  const invalidFallback = fallbackProviders.find((provider) => !LLM_PROVIDERS.has(provider));
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
      SELECT provider, api_key_ref, default_model, enabled
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
      const adapter = buildHealthAdapter(row.provider, row.api_key_ref, row.default_model);
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

function buildHealthAdapter(provider, apiKeyRef, defaultModel) {
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
  throw new Error(`Unsupported provider: ${provider}`);
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

  if (req.method === "GET" && pathname === "/v1/schema-objects") {
    return handleListSchemaObjects(req, res, requestUrl);
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

  if (req.method === "POST" && pathname === "/v1/rag/reindex") {
    return handleRagReindex(req, res, requestUrl);
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
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
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
