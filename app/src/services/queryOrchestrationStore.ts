import appDb = require("../lib/appDb");
import { LLM_PROVIDERS } from "../lib/constants";

export interface SessionRow {
  session_id: string;
  question: string;
  data_source_id: string;
  connection_ref: string;
  db_type: string;
}

export interface QueryContext {
  schemaObjects: Array<{ id: string; schema_name: string; object_name: string; object_type: string }>;
  columns: Array<{ schema_name: string; object_name: string; column_name: string; data_type: string }>;
  semanticEntities: Array<{ id: string; entity_type: string; target_ref: string; business_name: string }>;
  metricDefinitions: Array<{ id: string; semantic_entity_id: string; sql_expression: string; grain: string | null; business_name: string }>;
  joinPolicies: Array<{ id: string; left_ref: string; right_ref: string; join_type: string; on_clause: string }>;
  ragNotes: Array<{ id: string; title: string; content: string }>;
}

export interface InsertQueryAttemptInput {
  sessionId: string;
  usedProvider: string;
  usedModel: string;
  promptVersion: string;
  generatedSql: string;
  validationJson: Record<string, unknown>;
  latencyMs: number;
  generationTokenUsage: unknown;
  returnId?: boolean;
}

export interface InsertQueryResultMetaInput {
  attemptId: string;
  rowCount: number;
  durationMs: number;
  truncated: boolean;
}

export interface ResolveSessionInput {
  sessionId: string;
  question?: string;
  dataSourceId?: string;
  connectionRef?: string;
  dbType?: string;
}

export async function resolveSession({ sessionId, question, dataSourceId, connectionRef, dbType }: ResolveSessionInput): Promise<SessionRow | null> {
  if (question && dataSourceId && connectionRef && dbType) {
    return {
      session_id: sessionId,
      question,
      data_source_id: dataSourceId,
      connection_ref: connectionRef,
      db_type: dbType
    };
  }

  const sessionResult = await appDb.query<SessionRow>(
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

export async function loadQueryContext(dataSourceId: string): Promise<QueryContext> {
  const [
    schemaObjectsResult,
    columnsResult,
    semanticEntitiesResult,
    metricDefinitionsResult,
    joinPoliciesResult,
    ragNotesResult
  ] = await Promise.all([
    appDb.query<{ id: string; schema_name: string; object_name: string; object_type: string }>(
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
    appDb.query<{ schema_name: string; object_name: string; column_name: string; data_type: string }>(
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
    appDb.query<{ id: string; entity_type: string; target_ref: string; business_name: string }>(
      `
        SELECT id, entity_type, target_ref, business_name
        FROM semantic_entities
        WHERE data_source_id = $1 AND active = TRUE
        ORDER BY business_name
      `,
      [dataSourceId]
    ),
    appDb.query<{ id: string; semantic_entity_id: string; sql_expression: string; grain: string | null; business_name: string }>(
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
    appDb.query<{ id: string; left_ref: string; right_ref: string; join_type: string; on_clause: string }>(
      `
        SELECT id, left_ref, right_ref, join_type, on_clause
        FROM join_policies
        WHERE data_source_id = $1 AND approved = TRUE
        ORDER BY left_ref, right_ref
      `,
      [dataSourceId]
    ),
    appDb.query<{ id: string; title: string; content: string }>(
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

export async function validateRequestedProvider(requestedProvider: string | null | undefined): Promise<boolean> {
  if (!requestedProvider || (LLM_PROVIDERS as ReadonlySet<string>).has(requestedProvider)) {
    return true;
  }

  const providerResult = await appDb.query("SELECT 1 FROM llm_providers WHERE provider = $1", [requestedProvider]);
  return (providerResult.rowCount ?? 0) > 0;
}

export async function insertQueryAttempt({
  sessionId,
  usedProvider,
  usedModel,
  promptVersion,
  generatedSql,
  validationJson,
  latencyMs,
  generationTokenUsage,
  returnId = false
}: InsertQueryAttemptInput): Promise<string | null> {
  const result = await appDb.query<{ id: string }>(
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

export async function markSessionStatus(sessionId: string, status: string): Promise<void> {
  await appDb.query("UPDATE query_sessions SET status = $2 WHERE id = $1", [sessionId, status]);
}

export async function insertQueryResultMeta({ attemptId, rowCount, durationMs, truncated }: InsertQueryResultMetaInput): Promise<void> {
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
