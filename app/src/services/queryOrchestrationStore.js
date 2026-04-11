const appDb = require("../lib/appDb");
const { LLM_PROVIDERS } = require("../lib/constants");

async function resolveSession({ sessionId, question, dataSourceId, connectionRef, dbType }) {
  if (question && dataSourceId && connectionRef && dbType) {
    return {
      session_id: sessionId,
      question,
      data_source_id: dataSourceId,
      connection_ref: connectionRef,
      db_type: dbType
    };
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

  return sessionResult.rows[0] || null;
}

async function loadQueryContext(dataSourceId) {
  const [
    schemaObjectsResult,
    columnsResult,
    semanticEntitiesResult,
    metricDefinitionsResult,
    joinPoliciesResult,
    ragNotesResult
  ] = await Promise.all([
    appDb.query(
      `
        SELECT id, schema_name, object_name, object_type
        FROM schema_objects
        WHERE data_source_id = $1
          AND is_ignored = FALSE
          AND object_type IN ('table', 'view', 'materialized_view')
        ORDER BY schema_name, object_name
      `,
      [dataSourceId]
    ),
    appDb.query(
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
      [dataSourceId]
    ),
    appDb.query(
      `
        SELECT id, entity_type, target_ref, business_name
        FROM semantic_entities
        WHERE data_source_id = $1 AND active = TRUE
        ORDER BY business_name
      `,
      [dataSourceId]
    ),
    appDb.query(
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
      [dataSourceId]
    ),
    appDb.query(
      `
        SELECT id, left_ref, right_ref, join_type, on_clause
        FROM join_policies
        WHERE data_source_id = $1 AND approved = TRUE
        ORDER BY left_ref, right_ref
      `,
      [dataSourceId]
    ),
    appDb.query(
      `
        SELECT id, title, content
        FROM rag_notes
        WHERE data_source_id = $1 AND active = TRUE
        ORDER BY created_at DESC
      `,
      [dataSourceId]
    )
  ]);

  return {
    schemaObjects: schemaObjectsResult.rows,
    columns: columnsResult.rows,
    semanticEntities: semanticEntitiesResult.rows,
    metricDefinitions: metricDefinitionsResult.rows,
    joinPolicies: joinPoliciesResult.rows,
    ragNotes: ragNotesResult.rows
  };
}

async function validateRequestedProvider(requestedProvider) {
  if (!requestedProvider || LLM_PROVIDERS.has(requestedProvider)) {
    return true;
  }

  const providerResult = await appDb.query("SELECT 1 FROM llm_providers WHERE provider = $1", [requestedProvider]);
  return providerResult.rowCount > 0;
}

async function insertQueryAttempt({
  sessionId,
  usedProvider,
  usedModel,
  promptVersion,
  generatedSql,
  validationJson,
  latencyMs,
  generationTokenUsage,
  returnId = false
}) {
  const result = await appDb.query(
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
      ${returnId ? "RETURNING id" : ""}
    `,
    [
      sessionId,
      usedProvider,
      usedModel,
      promptVersion,
      generatedSql,
      validationJson,
      latencyMs,
      generationTokenUsage
    ]
  );

  return returnId ? result.rows[0]?.id || null : null;
}

async function markSessionStatus(sessionId, status) {
  await appDb.query("UPDATE query_sessions SET status = $2 WHERE id = $1", [sessionId, status]);
}

async function insertQueryResultMeta({ attemptId, rowCount, durationMs, truncated }) {
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
    [attemptId, rowCount, durationMs, truncated]
  );
}

module.exports = {
  insertQueryAttempt,
  insertQueryResultMeta,
  loadQueryContext,
  markSessionStatus,
  resolveSession,
  validateRequestedProvider
};
