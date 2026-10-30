import "./helpers/setupEnv";
import { after, before, beforeEach, test } from "node:test";
import assert from "node:assert/strict";

process.env.DATABASE_URL = process.env.DATABASE_URL || "postgresql://test:test@localhost:5432/test";

import appDb = require("../src/lib/appDb");
import {
  orchestrateQueryRun,
  type QueryOrchestrationDependencies
} from "../src/services/queryOrchestrationService";
import type { GenerateSqlWithRoutingInput, GenerateSqlWithRoutingResult } from "../src/services/llmSqlService";
import type { DbAdapter } from "../src/adapters/types";
import type { QueryDiagnosticInput } from "../src/services/queryDiagnosticsService";
import type { SessionRefinement } from "../src/services/queryOrchestrationStore";

const SESSION_ID = "00000000-0000-4000-8000-000000000101";
const DATA_SOURCE_ID = "00000000-0000-4000-8000-000000000111";
const TABLE_ID = "00000000-0000-4000-8000-000000000201";
const ATTEMPT_ID = "00000000-0000-4000-8000-000000000301";
const PARENT_SESSION_ID = "00000000-0000-4000-8000-000000000102";

let originalQuery: typeof appDb.query;
let insertedSql: string[];
let insertedValidation: Array<Record<string, unknown>>;
let statuses: string[];
let emittedDiagnostics: QueryDiagnosticInput[];

before(() => {
  originalQuery = appDb.query;
  appDb.query = (async (sql: string, params: unknown[] = []) => {
    const normalized = sql.replace(/\s+/g, " ").trim().toLowerCase();
    if (normalized.startsWith("insert into query_attempts")) {
      insertedSql.push(String(params[4]));
      insertedValidation.push(params[5] as Record<string, unknown>);
      return normalized.includes("returning id")
        ? { rowCount: 1, rows: [{ id: ATTEMPT_ID }] }
        : { rowCount: 1, rows: [] };
    }
    if (normalized.startsWith("update query_sessions set status")) {
      statuses.push(String(params[1]));
      return { rowCount: 1, rows: [] };
    }
    if (normalized.startsWith("insert into query_results_meta")) {
      return { rowCount: 1, rows: [] };
    }
    throw new Error(`Unexpected SQL: ${normalized}`);
  }) as typeof appDb.query;
});

beforeEach(() => {
  insertedSql = [];
  insertedValidation = [];
  statuses = [];
  emittedDiagnostics = [];
});

after(() => {
  appDb.query = originalQuery;
});

test("orchestrateQueryRun repairs invalid SQL once and reruns the safety pipeline", async () => {
  const stages: string[] = [];
  const dependencies = dependenciesWithGenerator(async (input) => {
    stages.push(input.stage || "generation");
    return input.stage === "repair"
      ? generation("SELECT SUM(amount) AS total_revenue FROM public.payment", "repair")
      : generation("DELETE FROM public.payment", "generation");
  });

  const result = await orchestrateQueryRun(baseInput(), dependencies);

  assert.equal(result.ok, true);
  assert.equal(result.statusCode, 200);
  assert.equal((result.body as { sql: string }).sql, "SELECT SUM(amount) AS total_revenue FROM public.payment;");
  assert.deepEqual(stages, ["generation", "repair"]);
  assert.equal(insertedSql.length, 2);
  assert.match(insertedSql[0], /^DELETE/i);
  assert.match(insertedSql[1], /^SELECT/i);
  assert.deepEqual(statuses, ["completed"]);
  const diagnostics = (result.body as {
    diagnostics: { repair_count: number; prompts: { generation_chars: number; repair_chars: number; total_chars: number } };
  }).diagnostics;
  assert.equal(diagnostics.repair_count, 1);
  assert.deepEqual(diagnostics.prompts, {
    linker_chars: 0,
    generation_chars: 600,
    repair_chars: 800,
    total_chars: 1400
  });
  assert.equal(emittedDiagnostics.length, 1);
  assert.equal(emittedDiagnostics[0].requestId, "request-1");
  assert.equal(emittedDiagnostics[0].outcome, "succeeded");
  assert.equal(emittedDiagnostics[0].terminalStage, "validation");
  assert.equal(emittedDiagnostics[0].repairCount, 1);
});

test("orchestrateQueryRun stops after one failed repair and marks it exhausted", async () => {
  const stages: string[] = [];
  const dependencies = dependenciesWithGenerator(async (input) => {
    stages.push(input.stage || "generation");
    return input.stage === "repair"
      ? generation("UPDATE public.payment SET amount = 0", "repair")
      : generation("DELETE FROM public.payment", "generation");
  });

  const result = await orchestrateQueryRun(baseInput(), dependencies);

  assert.equal(result.ok, false);
  assert.equal(result.statusCode, 400);
  assert.equal((result.body as { error: string }).error, "invalid_sql");
  assert.equal((result.body as { repair_exhausted: boolean }).repair_exhausted, true);
  assert.deepEqual(stages, ["generation", "repair"]);
  assert.equal(insertedSql.length, 2);
  assert.deepEqual(statuses, ["failed"]);
  assert.equal(emittedDiagnostics.length, 1);
  assert.equal(emittedDiagnostics[0].outcome, "failed");
  assert.equal(emittedDiagnostics[0].errorCode, "invalid_sql");
});

test("orchestrateQueryRun repairs adapter validation errors before EXPLAIN and execution", async () => {
  const validationCalls: string[] = [];
  let closed = false;
  const adapter = fakeAdapter({
    validateSql: async (sql) => {
      validationCalls.push(sql);
      return sql.includes("missing_column")
        ? { ok: false, errors: ["column missing_column does not exist"] }
        : { ok: true, errors: [] };
    },
    close: async () => {
      closed = true;
    }
  });
  const dependencies = dependenciesWithGenerator(async (input) => input.stage === "repair"
    ? generation("SELECT amount FROM public.payment", "repair")
    : generation("SELECT missing_column FROM public.payment", "generation"));
  dependencies.createDatabaseAdapter = () => adapter;

  const result = await orchestrateQueryRun({ ...baseInput(), noExecute: false }, dependencies);

  assert.equal(result.ok, true);
  assert.deepEqual(validationCalls.length, 2);
  assert.match(validationCalls[0], /missing_column/);
  assert.match(validationCalls[1], /amount/);
  assert.equal((result.body as { row_count: number }).row_count, 1);
  assert.equal(closed, true);
});

test("ambiguous generation persists clarification and returns the structured 422 response", async () => {
  let recorded = false;
  const dependencies = dependenciesWithGenerator(async () => generation("SELECT 1", "generation"));
  dependencies.prepareQueryGenerationContext = async () => ({
    ok: false,
    code: "schema_linking_ambiguous",
    message: "Multiple equally valid join paths were found",
    clarification: {
      kind: "join_path",
      message: "Choose a relationship",
      options: [
        { id: "join_path_111111111111", label: "Path one", description: "First path", table_refs: ["public.a", "public.b"] },
        { id: "join_path_222222222222", label: "Path two", description: "Second path", table_refs: ["public.a", "public.b"] }
      ]
    },
    diagnostics: { candidates: [], linker: null, expansion: null }
  });
  dependencies.recordPendingClarification = async () => {
    recorded = true;
  };

  const result = await orchestrateQueryRun(baseInput(), dependencies);

  assert.equal(result.statusCode, 422);
  assert.equal(recorded, true);
  assert.equal((result.body as { clarification: { options: unknown[] } }).clarification.options.length, 2);
});

test("resume refuses a valid current option when the session has no pending clarification", async () => {
  let generationCalled = false;
  const dependencies = dependenciesWithGenerator(async () => {
    generationCalled = true;
    return generation("SELECT 1", "generation");
  });
  dependencies.resolvePendingClarification = async () => false;

  const result = await orchestrateQueryRun({
    ...baseInput(),
    clarificationOptionId: "join_path_111111111111"
  }, dependencies);

  assert.equal(result.statusCode, 409);
  assert.equal((result.body as { error: string }).error, "clarification_not_pending");
  assert.equal(generationCalled, false);
});

const REFINEMENT: SessionRefinement = {
  parentSessionId: PARENT_SESSION_ID,
  previousQuestions: ["generate report for payments", "only refunded payments"],
  baseSql: "SELECT payment_id, amount FROM public.payment WHERE amount < 0 LIMIT 100"
};

test("refinement sessions link schema on the combined question and pass refinement to generation and repair", async () => {
  const linkingQuestions: string[] = [];
  const requiredRefs: Array<string[] | undefined> = [];
  const generatorCalls: GenerateSqlWithRoutingInput[] = [];
  const dependencies = dependenciesWithGenerator(async (input) => {
    generatorCalls.push(input);
    return input.stage === "repair"
      ? generation("SELECT payment_id, amount FROM public.payment WHERE amount < 0", "repair")
      : generation("DELETE FROM public.payment", "generation");
  });
  const prepare = dependencies.prepareQueryGenerationContext;
  dependencies.prepareQueryGenerationContext = async (input, ...rest) => {
    linkingQuestions.push(input.question);
    requiredRefs.push(input.requiredObjectRefs);
    return prepare(input, ...rest);
  };
  const refinementLookups: string[] = [];
  dependencies.loadSessionRefinement = async (sessionId) => {
    refinementLookups.push(sessionId);
    return REFINEMENT;
  };

  const result = await orchestrateQueryRun({ ...baseInput(), question: "limit this to past 3 months" }, dependencies);

  assert.equal(result.ok, true);
  assert.deepEqual(refinementLookups, [SESSION_ID], "refinement loads even when every session field is passed in");
  assert.deepEqual(linkingQuestions, [
    "Earlier requests:\n1. generate report for payments\n2. only refunded payments\nFollow-up request: limit this to past 3 months"
  ]);
  assert.deepEqual(requiredRefs, [["public.payment"]], "tables of the refined SQL stay in the schema context");
  assert.deepEqual(generatorCalls.map((call) => call.stage || "generation"), ["generation", "repair"]);
  for (const call of generatorCalls) {
    assert.equal(call.question, "limit this to past 3 months");
    assert.deepEqual(call.refinement, {
      previousQuestions: REFINEMENT.previousQuestions,
      baseSql: REFINEMENT.baseSql
    });
  }
  assert.equal(insertedValidation.length, 2);
  for (const validation of insertedValidation) {
    assert.deepEqual(validation.refinement, { parent_session_id: PARENT_SESSION_ID, previous_question_count: 2 });
  }
  assert.equal(insertedValidation[0].ok, false);
  assert.equal(insertedValidation[1].ok, true);
  assert.deepEqual(emittedDiagnostics[0].refinement, { parentSessionId: PARENT_SESSION_ID, ancestorCount: 2 });
});

test("refinement context survives a budget repair", async () => {
  const generatorCalls: GenerateSqlWithRoutingInput[] = [];
  const dependencies = dependenciesWithGenerator(async (input) => {
    generatorCalls.push(input);
    return input.stage === "repair"
      ? generation("SELECT amount FROM public.payment WHERE amount < 0", "repair")
      : generation("SELECT payment_id, amount FROM public.payment", "generation");
  });
  dependencies.loadSessionRefinement = async () => REFINEMENT;
  dependencies.createDatabaseAdapter = () => fakeAdapter({
    explain: async (sql) => [{
      "QUERY PLAN": [{ Plan: { "Total Cost": sql.includes("payment_id") ? 1e12 : 1, "Plan Rows": 1 } }]
    }]
  });

  const result = await orchestrateQueryRun({ ...baseInput(), noExecute: false }, dependencies);

  assert.equal(result.ok, true);
  assert.deepEqual(generatorCalls.map((call) => call.stage || "generation"), ["generation", "repair"]);
  assert.equal(generatorCalls[1].refinement?.baseSql, REFINEMENT.baseSql);
  assert.match(generatorCalls[1].repair?.errors.join(" ") || "", /cost/i);
});

test("non-refinement sessions keep the original question and no refinement context", async () => {
  const linkingQuestions: string[] = [];
  const generatorCalls: GenerateSqlWithRoutingInput[] = [];
  const dependencies = dependenciesWithGenerator(async (input) => {
    generatorCalls.push(input);
    return generation("SELECT amount FROM public.payment", "generation");
  });
  const prepare = dependencies.prepareQueryGenerationContext;
  dependencies.prepareQueryGenerationContext = async (input, ...rest) => {
    linkingQuestions.push(input.question);
    return prepare(input, ...rest);
  };

  const result = await orchestrateQueryRun(baseInput(), dependencies);

  assert.equal(result.ok, true);
  assert.deepEqual(linkingQuestions, ["What is total revenue?"]);
  assert.equal(generatorCalls[0].refinement, null);
  assert.equal(insertedValidation[0].refinement, null);
  assert.equal(emittedDiagnostics[0].refinement, null);
});

test("refinement without validated base SQL fails closed before generation", async () => {
  let generationCalled = false;
  const dependencies = dependenciesWithGenerator(async () => {
    generationCalled = true;
    return generation("SELECT 1", "generation");
  });
  dependencies.loadSessionRefinement = async () => ({ ...REFINEMENT, baseSql: null });

  const result = await orchestrateQueryRun(baseInput(), dependencies);

  assert.equal(result.statusCode, 409);
  assert.equal((result.body as { error: string }).error, "refinement_base_unavailable");
  assert.equal(generationCalled, false);
  assert.deepEqual(statuses, ["failed"]);
});

function baseInput() {
  return {
    sessionId: SESSION_ID,
    question: "What is total revenue?",
    dataSourceId: DATA_SOURCE_ID,
    requestId: "request-1",
    connectionRef: "postgresql://unused",
    dbType: "postgres",
    maxRows: 100,
    noExecute: true
  };
}

function dependenciesWithGenerator(
  generate: (input: GenerateSqlWithRoutingInput) => Promise<GenerateSqlWithRoutingResult>
): QueryOrchestrationDependencies {
  return {
    prepareQueryGenerationContext: async () => ({
      ok: true,
      context: {
        schemaObjects: [{ id: TABLE_ID, schema_name: "public", object_name: "payment", object_type: "table" }],
        columns: [
          { schema_name: "public", object_name: "payment", column_name: "payment_id", data_type: "integer" },
          { schema_name: "public", object_name: "payment", column_name: "amount", data_type: "numeric" }
        ],
        semanticEntities: [],
        metricDefinitions: [],
        joinPolicies: [],
        ragNotes: []
      },
      ragDocuments: [],
      diagnostics: {
        candidates: [{
          id: TABLE_ID,
          ref: "public.payment",
          score: 10,
          lexical_score: 10,
          rag_score: 0,
          matched_terms: ["revenue"]
        }],
        linker: null,
        expansion: null
      }
    }),
    generateSqlWithRouting: generate,
    emitQueryDiagnostic: (diagnostic) => {
      emittedDiagnostics.push(diagnostic);
    },
    recordPendingClarification: async () => undefined,
    resolvePendingClarification: async () => true,
    loadResolvedClarificationOptionIds: async () => [],
    loadSessionRefinement: async () => null,
    createDatabaseAdapter: () => {
      throw new Error("Adapter must not be created for no_execute tests");
    }
  };
}

function generation(sql: string, stage: "generation" | "repair"): GenerateSqlWithRoutingResult {
  return {
    sql,
    provider: "openai",
    model: "test-model",
    attempts: [{
      provider: "openai",
      model: "test-model",
      status: "success",
      status_code: 200,
      latency_ms: 1,
      usage: null,
      stage
    }],
    tokenUsage: null,
    promptVersion: stage === "repair" ? "v3-scoped-repair" : "v3-scoped-generation",
    promptChars: stage === "repair" ? 800 : 600
  };
}

function fakeAdapter(overrides: Partial<DbAdapter> = {}): DbAdapter {
  return {
    type: "postgres",
    dialect: () => "postgres",
    testConnection: async () => undefined,
    introspectSchema: async () => ({ objects: [], columns: [], relationships: [], indexes: [] }),
    validateSql: async () => ({ ok: true, errors: [] }),
    explain: async () => [{ "QUERY PLAN": [{ Plan: { "Total Cost": 1, "Plan Rows": 1 } }] }],
    execute: async () => ({
      columns: ["amount"], rows: [{ amount: 10 }], rowCount: 1, originalRowCount: 1, truncated: false, durationMs: 1
    }),
    executeReadOnly: async () => ({
      columns: ["amount"], rows: [{ amount: 10 }], rowCount: 1, originalRowCount: 1, truncated: false, durationMs: 1
    }),
    executeParameterizedReadOnly: async () => ({
      columns: ["amount"], rows: [{ amount: 10 }], rowCount: 1, originalRowCount: 1, truncated: false, durationMs: 1
    }),
    quoteIdentifier: (identifier) => `"${identifier}"`,
    close: async () => undefined,
    ...overrides
  };
}
