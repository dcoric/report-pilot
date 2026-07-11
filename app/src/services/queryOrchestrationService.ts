import {
  EXPLAIN_BUDGET_ENABLED,
  EXPLAIN_MAX_TOTAL_COST,
  EXPLAIN_MAX_PLAN_ROWS
} from "../lib/constants";
import { createDatabaseAdapter, isSupportedDbType } from "../adapters/dbAdapterFactory";
import { generateSqlWithRouting, type ProviderAttempt } from "./llmSqlService";
import { validateAndNormalizeSql } from "./sqlSafety";
import columnPolicyService = require("./columnPolicyService");
import { evaluateExplainBudget } from "./queryBudget";
import { buildCitations, computeConfidence, type Citations } from "./queryResponse";
import ragRetrieval = require("./ragRetrieval");
import { isLikelyInvalidSqlExecutionError } from "../lib/validation";
import {
  insertQueryAttempt,
  insertQueryResultMeta,
  loadQueryContext,
  markSessionStatus,
  resolveSession,
  validateRequestedProvider
} from "./queryOrchestrationStore";
import type { DbAdapter } from "../adapters/types";
import { prepareQueryGenerationContext, type SchemaLinkingDiagnostics } from "./queryGenerationContextService";
import type { QueryContext } from "./queryOrchestrationStore";
import type { RagRetrievalDoc } from "./ragRetrieval";

const { extractForbiddenColumnsFromRagNotes, validateSqlAgainstForbiddenColumns } = columnPolicyService;
const { retrieveRagContext } = ragRetrieval;

export interface OrchestrateInput {
  sessionId: string;
  question?: string;
  dataSourceId?: string;
  connectionRef?: string;
  dbType?: string;
  requestId?: string | null;
  requestedProvider?: string | null;
  requestedModel?: string | null;
  sqlOverride?: string | null;
  maxRows: number;
  timeoutMs?: number;
  noExecute?: boolean;
}

export interface OrchestrateResult<T = unknown> {
  ok: boolean;
  statusCode: number;
  body: T;
}

export interface QueryOrchestrationDependencies {
  prepareQueryGenerationContext: typeof prepareQueryGenerationContext;
  generateSqlWithRouting: typeof generateSqlWithRouting;
  createDatabaseAdapter: typeof createDatabaseAdapter;
}

const defaultDependencies: QueryOrchestrationDependencies = {
  prepareQueryGenerationContext,
  generateSqlWithRouting,
  createDatabaseAdapter
};

function success<T>(body: T, statusCode = 200): OrchestrateResult<T> {
  return { ok: true, statusCode, body };
}

function failure<T>(statusCode: number, body: T): OrchestrateResult<T> {
  return { ok: false, statusCode, body };
}

interface BuildValidationJsonInput {
  ok: boolean;
  errors: string[];
  references: unknown[];
  generationAttempts: ProviderAttempt[];
  repairs: Array<{
    errors: string[];
    provider: string;
    model: string | null;
    prompt_version: string;
  }>;
  schemaLinking: SchemaLinkingDiagnostics | null;
  noExecute: boolean;
  requestId?: string | null;
}

function buildValidationJson(input: BuildValidationJsonInput): Record<string, unknown> {
  return {
    ok: input.ok,
    errors: input.errors,
    references: input.references,
    provider_attempts: input.generationAttempts,
    repair_attempts: input.repairs,
    schema_linking: input.schemaLinking,
    execution: {
      skipped: input.noExecute,
      reason: input.noExecute ? "no_execute" : null
    },
    trace: {
      request_id: input.requestId || null
    }
  };
}

export async function orchestrateQueryRun({
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
}: OrchestrateInput, dependencies: QueryOrchestrationDependencies = defaultDependencies): Promise<OrchestrateResult> {
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

  const sqlDialect: "postgres" | "mssql" = session.db_type === "mssql" ? "mssql" : "postgres";
  const generationStartedAt = Date.now();
  let context: QueryContext;
  let ragDocuments: RagRetrievalDoc[];
  let schemaLinking: SchemaLinkingDiagnostics | null = null;

  if (sqlOverride) {
    [context, ragDocuments] = await Promise.all([
      loadQueryContext(session.data_source_id),
      retrieveRagContext(session.data_source_id, session.question, { limit: 12 })
    ]);
  } else {
    let prepared;
    try {
      prepared = await dependencies.prepareQueryGenerationContext({
        dataSourceId: session.data_source_id,
        question: session.question,
        requestedProvider,
        requestedModel,
        requestId
      });
    } catch (err) {
      await markSessionStatus(sessionId, "failed");
      return failure(502, {
        error: "schema_linking_failed",
        message: (err as Error).message
      });
    }
    schemaLinking = prepared.diagnostics;
    if (prepared.ok === false) {
      await markSessionStatus(sessionId, "failed");
      return failure(422, {
        error: prepared.code,
        message: prepared.message,
        schema_linking: prepared.diagnostics
      });
    }
    context = prepared.context;
    ragDocuments = prepared.ragDocuments;
  }
  const forbiddenColumns = extractForbiddenColumnsFromRagNotes(context.ragNotes, context.columns);

  let generatedSql: string;
  let usedProvider = "unknown";
  let usedModel: string = requestedModel || "unknown";
  let generationAttempts: ProviderAttempt[] = [];
  let generationTokenUsage: unknown = null;
  let promptVersion = "v3-scoped-generation";

  if (sqlOverride) {
    generatedSql = sqlOverride;
    usedProvider = "cached_history";
    usedModel = "n/a";
    promptVersion = "v2-cached-sql";
  } else {
    try {
      const generation = await dependencies.generateSqlWithRouting({
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
        message: (err as Error).message
      });
    }
  }

  let adapter: DbAdapter | null = null;
  const repairs: Array<{
    errors: string[];
    provider: string;
    model: string | null;
    prompt_version: string;
  }> = [];

  try {
    let safeSql = generatedSql;
    let safety = validateAndNormalizeSql(generatedSql, {
      maxRows,
      schemaObjects: context.schemaObjects,
      dialect: sqlDialect
    });
    let validationJson: Record<string, unknown> = {};

    while (true) {
      let validationErrors: string[] = [];
      safeSql = generatedSql;
      safety = validateAndNormalizeSql(generatedSql, {
        maxRows,
        schemaObjects: context.schemaObjects,
        dialect: sqlDialect
      });

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

        if (!noExecute && validationErrors.length === 0) {
          if (!adapter) {
            try {
              adapter = dependencies.createDatabaseAdapter(session.db_type, session.connection_ref);
            } catch (err) {
              return failure(400, { error: "bad_request", message: (err as Error).message });
            }
          }
          const adapterValidation = await adapter.validateSql(safeSql);
          if (!adapterValidation.ok) {
            validationErrors = adapterValidation.errors;
          }
        }
      }

      validationJson = buildValidationJson({
        ok: validationErrors.length === 0,
        errors: validationErrors,
        references: safety.refs || [],
        generationAttempts,
        repairs,
        schemaLinking,
        noExecute: Boolean(noExecute),
        requestId
      });

      if (validationErrors.length > 0) {
        if (!sqlOverride && repairs.length === 0) {
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
          const previousSql = generatedSql;
          let repair;
          try {
            repair = await dependencies.generateSqlWithRouting({
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
              ragDocuments,
              repair: { previousSql, errors: validationErrors },
              stage: "repair"
            });
          } catch (err) {
            await markSessionStatus(sessionId, "failed");
            return failure(502, {
              error: "llm_repair_failed",
              message: (err as Error).message,
              details: validationErrors,
              sql: previousSql
            });
          }
          generatedSql = repair.sql;
          usedProvider = repair.provider;
          usedModel = repair.model || usedModel;
          generationAttempts = generationAttempts.concat(repair.attempts || []);
          generationTokenUsage = {
            generation: generationTokenUsage,
            repair: repair.tokenUsage || null
          };
          promptVersion = repair.promptVersion;
          repairs.push({
            errors: validationErrors,
            provider: repair.provider,
            model: repair.model,
            prompt_version: repair.promptVersion
          });
          continue;
        }

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
          sql: generatedSql,
          repair_exhausted: repairs.length > 0
        });
      }

      if (!noExecute && EXPLAIN_BUDGET_ENABLED && sqlDialect === "postgres") {
        const explainRows = await adapter!.explain(safeSql);
        const budget = evaluateExplainBudget(explainRows, {
          maxTotalCost: EXPLAIN_MAX_TOTAL_COST,
          maxPlanRows: EXPLAIN_MAX_PLAN_ROWS
        });
        validationJson.explain_budget = budget;
        if (!budget.ok) {
          validationJson.ok = false;
          validationJson.errors = budget.errors;
          if (!sqlOverride && repairs.length === 0) {
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
            const previousSql = safeSql;
            let repair;
            try {
              repair = await dependencies.generateSqlWithRouting({
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
                ragDocuments,
                repair: { previousSql, errors: budget.errors },
                stage: "repair"
              });
            } catch (err) {
              await markSessionStatus(sessionId, "failed");
              return failure(502, {
                error: "llm_repair_failed",
                message: (err as Error).message,
                details: budget.errors,
                sql: previousSql
              });
            }
            generatedSql = repair.sql;
            usedProvider = repair.provider;
            usedModel = repair.model || usedModel;
            generationAttempts = generationAttempts.concat(repair.attempts || []);
            generationTokenUsage = { generation: generationTokenUsage, repair: repair.tokenUsage || null };
            promptVersion = repair.promptVersion;
            repairs.push({
              errors: budget.errors,
              provider: repair.provider,
              model: repair.model,
              prompt_version: repair.promptVersion
            });
            continue;
          }
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
            sql: safeSql,
            repair_exhausted: repairs.length > 0
          });
        }
      }
      break;
    }

    const citations = buildCitations({
      question: session.question,
      sql: safeSql,
      refs: safety.refs || [],
      schemaObjects: context.schemaObjects,
      semanticEntities: context.semanticEntities,
      metricDefinitions: context.metricDefinitions,
      joinPolicies: context.joinPolicies
    }) as Citations;
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

    const execution = await adapter!.executeReadOnly(safeSql, { timeoutMs, maxRows });
    await insertQueryResultMeta({
      attemptId: attemptId as string,
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
        details: [(err as Error).message],
        sql: generatedSql
      });
    }

    return failure(500, {
      error: "query_execution_failed",
      message: (err as Error).message,
      sql: generatedSql
    });
  } finally {
    if (adapter) {
      await adapter.close();
    }
  }
}
