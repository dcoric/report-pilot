const {
  EXPLAIN_BUDGET_ENABLED,
  EXPLAIN_MAX_TOTAL_COST,
  EXPLAIN_MAX_PLAN_ROWS
} = require("../lib/constants");
const { createDatabaseAdapter, isSupportedDbType } = require("../adapters/dbAdapterFactory");
const { generateSqlWithRouting } = require("./llmSqlService");
const { validateAndNormalizeSql } = require("./sqlSafety");
const {
  extractForbiddenColumnsFromRagNotes,
  validateSqlAgainstForbiddenColumns
} = require("./columnPolicyService");
const { evaluateExplainBudget } = require("./queryBudget");
const { buildCitations, computeConfidence } = require("./queryResponse");
const { retrieveRagContext } = require("./ragRetrieval");
const { isLikelyInvalidSqlExecutionError } = require("../lib/validation");
const {
  insertQueryAttempt,
  insertQueryResultMeta,
  loadQueryContext,
  markSessionStatus,
  resolveSession,
  validateRequestedProvider
} = require("./queryOrchestrationStore");

function success(body, statusCode = 200) {
  return { ok: true, statusCode, body };
}

function failure(statusCode, body) {
  return { ok: false, statusCode, body };
}

async function orchestrateQueryRun({
  sessionId,
  question,
  dataSourceId,
  connectionRef,
  dbType,
  requestId,
  requestedProvider,
  requestedModel,
  sqlOverride,
  maxRows,
  timeoutMs,
  noExecute
}) {
  const providerIsValid = await validateRequestedProvider(requestedProvider);
  if (!providerIsValid) {
    return failure(400, { error: "bad_request", message: "Unsupported llm_provider" });
  }

  const session = await resolveSession({
    sessionId,
    question,
    dataSourceId,
    connectionRef,
    dbType
  });

  if (!session) {
    return failure(404, { error: "not_found", message: "Session not found" });
  }

  if (!isSupportedDbType(session.db_type)) {
    return failure(400, {
      error: "bad_request",
      message: `Unsupported db_type for execution: ${session.db_type}`
    });
  }

  const sqlDialect = session.db_type === "mssql" ? "mssql" : "postgres";
  const context = await loadQueryContext(session.data_source_id);
  const ragDocuments = await retrieveRagContext(session.data_source_id, session.question, { limit: 12 });
  const forbiddenColumns = extractForbiddenColumnsFromRagNotes(context.ragNotes, context.columns);

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
        requestId: requestId || null,
        dataSourceId: session.data_source_id,
        dialect: sqlDialect,
        question: session.question,
        maxRows,
        requestedProvider,
        requestedModel,
        schemaObjects: context.schemaObjects,
        columns: context.columns,
        semanticEntities: context.semanticEntities,
        metricDefinitions: context.metricDefinitions,
        joinPolicies: context.joinPolicies,
        ragDocuments
      });

      generatedSql = generation.sql;
      usedProvider = generation.provider;
      usedModel = generation.model || usedModel;
      generationAttempts = generation.attempts || [];
      generationTokenUsage = generation.tokenUsage || null;
      promptVersion = generation.promptVersion || promptVersion;
    } catch (err) {
      await markSessionStatus(sessionId, "failed");
      return failure(502, {
        error: "llm_generation_failed",
        message: err.message
      });
    }
  }

  const generationStartedAt = Date.now();
  let adapter = null;

  try {
    const safety = validateAndNormalizeSql(generatedSql, {
      maxRows,
      schemaObjects: context.schemaObjects,
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
          return failure(400, { error: "bad_request", message: err.message });
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
        request_id: requestId || null
      }
    };

    if (validationErrors.length > 0) {
      await insertQueryAttempt({
        sessionId,
        usedProvider,
        usedModel,
        promptVersion,
        generatedSql,
        validationJson,
        latencyMs: Date.now() - generationStartedAt,
        generationTokenUsage
      });

      await markSessionStatus(sessionId, "failed");
      return failure(400, {
        error: "invalid_sql",
        details: validationErrors,
        sql: generatedSql
      });
    }

    if (!noExecute && EXPLAIN_BUDGET_ENABLED && sqlDialect === "postgres") {
      const explainRows = await adapter.explain(safeSql);
      const budget = evaluateExplainBudget(explainRows, {
        maxTotalCost: EXPLAIN_MAX_TOTAL_COST,
        maxPlanRows: EXPLAIN_MAX_PLAN_ROWS
      });

      validationJson.explain_budget = budget;
      if (!budget.ok) {
        await insertQueryAttempt({
          sessionId,
          usedProvider,
          usedModel,
          promptVersion,
          generatedSql: safeSql,
          validationJson,
          latencyMs: Date.now() - generationStartedAt,
          generationTokenUsage
        });

        await markSessionStatus(sessionId, "failed");
        return failure(400, {
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
      schemaObjects: context.schemaObjects,
      semanticEntities: context.semanticEntities,
      metricDefinitions: context.metricDefinitions,
      joinPolicies: context.joinPolicies
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

    const attemptId = await insertQueryAttempt({
      sessionId,
      usedProvider,
      usedModel,
      promptVersion,
      generatedSql: safeSql,
      validationJson,
      latencyMs: Date.now() - generationStartedAt,
      generationTokenUsage,
      returnId: true
    });

    if (noExecute) {
      await markSessionStatus(sessionId, "completed");
      return success({
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
    await insertQueryResultMeta({
      attemptId,
      rowCount: execution.rowCount,
      durationMs: execution.durationMs,
      truncated: execution.truncated
    });

    await markSessionStatus(sessionId, "completed");

    return success({
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
    await markSessionStatus(sessionId, "failed");

    if (isLikelyInvalidSqlExecutionError(err, sqlDialect)) {
      return failure(400, {
        error: "invalid_sql",
        details: [err.message],
        sql: generatedSql
      });
    }

    return failure(500, {
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

module.exports = {
  orchestrateQueryRun
};
