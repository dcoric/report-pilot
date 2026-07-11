import appDb = require("../lib/appDb");
import {
  json,
  badRequest,
  readJsonBody,
  type RouteHandler,
  type RouteHandlerWithId,
  type RouteHandlerWithUrl
} from "../lib/http";
import { clamp, isUuid } from "../lib/validation";
import { validateAndNormalizeSql } from "../services/sqlSafety";
import ragService = require("../services/ragService");
import { orchestrateQueryRun } from "../services/queryOrchestrationService";
import { enforceDataSourceAccess, listAccessibleDataSourceIds } from "../lib/authGate";
import type {
  CreateSessionRequest,
  CreateSessionResponse,
  RunSessionRequest,
  RunSessionResponse,
  FeedbackRequest
} from "../types";

const handleCreateSession: RouteHandler<CreateSessionRequest, CreateSessionResponse> = async (req, res) => {
  const body = await readJsonBody<Partial<CreateSessionRequest>>(req);
  const { data_source_id: dataSourceId, question } = body;

  if (!dataSourceId || !question) {
    return badRequest(res, "data_source_id and question are required");
  }

  const sourceResult = await appDb.query("SELECT id FROM data_sources WHERE id = $1", [dataSourceId]);
  if (sourceResult.rowCount === 0) {
    return json(res, 404, { error: "not_found", message: "Data source not found" });
  }

  if (!(await enforceDataSourceAccess(req, res, dataSourceId))) {
    return undefined;
  }

  const userId = req.user && req.user.id ? req.user.id : "anonymous";
  const sessionResult = await appDb.query<{ id: string }>(
    `
      INSERT INTO query_sessions (user_id, data_source_id, question, status)
      VALUES ($1, $2, $3, 'created')
      RETURNING id
    `,
    [userId, dataSourceId, question]
  );

  return json(res, 201, { session_id: sessionResult.rows[0].id, status: "created" });
};

const handlePromptHistory: RouteHandlerWithUrl = async (req, res, requestUrl) => {
  const userId = req.user && req.user.id ? req.user.id : "anonymous";
  const dataSourceId = requestUrl.searchParams.get("data_source_id");
  const search = (requestUrl.searchParams.get("q") || "").trim();
  const requestedLimit = Number(requestUrl.searchParams.get("limit") || 20);
  const limit = clamp(Number.isFinite(requestedLimit) ? requestedLimit : 20, 1, 200);

  if (dataSourceId && !isUuid(dataSourceId)) {
    return badRequest(res, "data_source_id must be a valid UUID");
  }

  if (dataSourceId && !(await enforceDataSourceAccess(req, res, dataSourceId))) {
    return undefined;
  }

  const accessible = await listAccessibleDataSourceIds(req);
  if (!dataSourceId && accessible && accessible.length === 0) {
    return json(res, 200, { items: [] });
  }
  const accessFilter = !dataSourceId && accessible ? accessible : null;

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
        AND ($5::uuid[] IS NULL OR qs.data_source_id = ANY($5::uuid[]))
      ORDER BY qs.created_at DESC
      LIMIT $4
    `,
    [userId, dataSourceId, search, limit, accessFilter]
  );

  return json(res, 200, { items: result.rows });
};

const handleRunSession: RouteHandlerWithId<RunSessionRequest, RunSessionResponse> = async (req, res, sessionId) => {
  const sessionLookup = await appDb.query<{ data_source_id: string }>(
    "SELECT data_source_id FROM query_sessions WHERE id = $1",
    [sessionId]
  );
  if (sessionLookup.rowCount === 0) {
    return json(res, 404, { error: "not_found", message: "Session not found" });
  }
  if (!(await enforceDataSourceAccess(req, res, sessionLookup.rows[0].data_source_id))) {
    return undefined;
  }

  const body = await readJsonBody<Partial<RunSessionRequest>>(req);
  const requestedProvider = typeof body.llm_provider === "string" ? body.llm_provider : null;
  const requestedModel = typeof body.model === "string" ? body.model : null;
  const noExecute = body.no_execute === true;
  const clarificationOptionId = typeof body.clarification_option_id === "string"
    ? body.clarification_option_id.trim()
    : null;
  if (clarificationOptionId && !/^join_path_[a-f0-9]{12}$/.test(clarificationOptionId)) {
    return badRequest(res, "clarification_option_id is invalid");
  }
  const sqlOverride = typeof body.sql_override === "string" && body.sql_override.trim() ? body.sql_override.trim() : null;
  const maxRows = clamp(Number(body.max_rows || 1000), 1, 100000);
  const timeoutMs = clamp(Number(body.timeout_ms || 20000), 1000, 120000);

  const result = await orchestrateQueryRun({
    sessionId,
    requestId: req.requestId || null,
    requestedProvider,
    requestedModel,
    sqlOverride,
    maxRows,
    timeoutMs,
    noExecute,
    clarificationOptionId
  });

  return json(res, result.statusCode, result.body);
};

const handleFeedback: RouteHandlerWithId<FeedbackRequest> = async (req, res, sessionId) => {
  const body = await readJsonBody<Partial<FeedbackRequest>>(req);
  const { rating, corrected_sql: correctedSql, comment } = body;

  if (!Number.isInteger(rating) || (rating as number) < 1 || (rating as number) > 5) {
    return badRequest(res, "rating must be an integer between 1 and 5");
  }

  const sessionResult = await appDb.query<{
    id: string;
    data_source_id: string;
    question: string;
    db_type: string;
  }>(
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

  if (!(await enforceDataSourceAccess(req, res, session.data_source_id))) {
    return undefined;
  }

  await appDb.query(
    `
      INSERT INTO user_feedback (session_id, rating, corrected_sql, comment)
      VALUES ($1, $2, $3, $4)
    `,
    [sessionId, rating, correctedSql || null, comment || null]
  );

  let exampleSaved = false;
  let exampleReason: string | null = null;

  if (correctedSql && String(correctedSql).trim()) {
    const schemaObjectsResult = await appDb.query<{ schema_name: string; object_name: string }>(
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
        [session.data_source_id, session.question, normalized.sql, (rating as number) / 5]
      );
      exampleSaved = true;
      ragService.triggerRagReindexAsync(session.data_source_id);
    }
  }

  return json(res, 200, { ok: true, example_saved: exampleSaved, example_reason: exampleReason });
};

export {
  handleCreateSession,
  handlePromptHistory,
  handleRunSession,
  handleFeedback
};
