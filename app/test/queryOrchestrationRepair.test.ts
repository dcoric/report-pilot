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

const SESSION_ID = "00000000-0000-4000-8000-000000000101";
const DATA_SOURCE_ID = "00000000-0000-4000-8000-000000000111";
const TABLE_ID = "00000000-0000-4000-8000-000000000201";
const ATTEMPT_ID = "00000000-0000-4000-8000-000000000301";

let originalQuery: typeof appDb.query;
let insertedSql: string[];
let statuses: string[];

before(() => {
  originalQuery = appDb.query;
  appDb.query = (async (sql: string, params: unknown[] = []) => {
    const normalized = sql.replace(/\s+/g, " ").trim().toLowerCase();
    if (normalized.startsWith("insert into query_attempts")) {
      insertedSql.push(String(params[4]));
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
  statuses = [];
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

function baseInput() {
  return {
    sessionId: SESSION_ID,
    question: "What is total revenue?",
    dataSourceId: DATA_SOURCE_ID,
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
