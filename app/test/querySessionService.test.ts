import "./helpers/setupEnv";
import { after, before, beforeEach, test } from "node:test";
import assert from "node:assert/strict";

import appDb = require("../src/lib/appDb");
import { createQuerySession } from "../src/services/querySessionService";
import { loadSessionRefinement, MAX_REFINEMENT_ANCESTORS } from "../src/services/queryOrchestrationStore";

const USER_ID = "user-1";
const DATA_SOURCE_ID = "00000000-0000-4000-8000-000000000111";
const OTHER_DATA_SOURCE_ID = "00000000-0000-4000-8000-000000000112";
const PARENT_ID = "00000000-0000-4000-8000-000000000201";
const GRANDPARENT_ID = "00000000-0000-4000-8000-000000000202";
const NEW_SESSION_ID = "00000000-0000-4000-8000-000000000301";

interface SessionFixture {
  user_id: string;
  data_source_id: string;
  validatedSql: string | null;
}

let originalQuery: typeof appDb.query;
let sessions: Map<string, SessionFixture>;
let ancestorRows: Array<{ id: string; question: string; depth: number }>;
let queries: Array<{ sql: string; params: unknown[] }>;
let insertedParams: unknown[] | null;

before(() => {
  originalQuery = appDb.query;
  appDb.query = (async (sql: string, params: unknown[] = []) => {
    const normalized = sql.replace(/\s+/g, " ").trim().toLowerCase();
    queries.push({ sql: normalized, params });
    if (normalized.startsWith("select user_id, data_source_id from query_sessions")) {
      const session = sessions.get(String(params[0]));
      return session
        ? { rowCount: 1, rows: [{ user_id: session.user_id, data_source_id: session.data_source_id }] }
        : { rowCount: 0, rows: [] };
    }
    if (normalized.startsWith("select generated_sql from query_attempts")) {
      assert.match(normalized, /validation_result_json->>'ok' = 'true'/);
      assert.match(normalized, /order by created_at desc limit 1/);
      const sqlText = sessions.get(String(params[0]))?.validatedSql;
      return sqlText ? { rowCount: 1, rows: [{ generated_sql: sqlText }] } : { rowCount: 0, rows: [] };
    }
    if (normalized.startsWith("insert into query_sessions")) {
      insertedParams = params;
      return { rowCount: 1, rows: [{ id: NEW_SESSION_ID }] };
    }
    if (normalized.startsWith("with recursive ancestors")) {
      return { rowCount: ancestorRows.length, rows: ancestorRows };
    }
    throw new Error(`Unexpected SQL: ${normalized}`);
  }) as typeof appDb.query;
});

beforeEach(() => {
  sessions = new Map([
    [PARENT_ID, { user_id: USER_ID, data_source_id: DATA_SOURCE_ID, validatedSql: "SELECT id FROM public.affiliates LIMIT 100" }]
  ]);
  ancestorRows = [];
  queries = [];
  insertedParams = null;
});

after(() => {
  appDb.query = originalQuery;
});

function create(parentSessionId: unknown) {
  return createQuerySession({
    userId: USER_ID,
    dataSourceId: DATA_SOURCE_ID,
    question: "limit this to past 3 months",
    parentSessionId
  });
}

test("createQuerySession without a parent inserts a plain session", async () => {
  const result = await create(undefined);

  assert.deepEqual(result, { ok: true, sessionId: NEW_SESSION_ID, parentSessionId: null });
  assert.deepEqual(insertedParams, [USER_ID, DATA_SOURCE_ID, "limit this to past 3 months", null]);
  assert.equal(queries.length, 1);
});

test("createQuerySession treats an explicit null parent as no parent", async () => {
  const result = await create(null);

  assert.equal(result.ok, true);
  assert.equal(insertedParams?.[3], null);
});

test("createQuerySession rejects a parent_session_id that is not a UUID", async () => {
  for (const value of ["not-a-uuid", 42, ""]) {
    const result = await create(value);
    assert.deepEqual(result, {
      ok: false,
      statusCode: 400,
      error: "bad_request",
      message: "parent_session_id must be a valid UUID"
    });
  }
  assert.equal(insertedParams, null);
  assert.equal(queries.length, 0);
});

test("createQuerySession hides missing and foreign parent sessions behind not_found", async () => {
  const missing = await create(GRANDPARENT_ID);
  sessions.set(PARENT_ID, { user_id: "someone-else", data_source_id: DATA_SOURCE_ID, validatedSql: "SELECT 1" });
  const foreign = await create(PARENT_ID);

  for (const result of [missing, foreign]) {
    assert.equal(result.ok, false);
    assert.equal(!result.ok && result.statusCode, 404);
    assert.equal(!result.ok && result.error, "not_found");
  }
  assert.equal(insertedParams, null);
});

test("createQuerySession rejects a parent from a different data source", async () => {
  sessions.set(PARENT_ID, { user_id: USER_ID, data_source_id: OTHER_DATA_SOURCE_ID, validatedSql: "SELECT 1" });

  const result = await create(PARENT_ID);

  assert.equal(result.ok, false);
  assert.equal(!result.ok && result.statusCode, 400);
  assert.equal(!result.ok && result.error, "bad_request");
  assert.equal(insertedParams, null);
});

test("createQuerySession requires validated SQL on the parent", async () => {
  sessions.set(PARENT_ID, { user_id: USER_ID, data_source_id: DATA_SOURCE_ID, validatedSql: null });

  const result = await create(PARENT_ID);

  assert.deepEqual(result, {
    ok: false,
    statusCode: 409,
    error: "refinement_base_unavailable",
    message: "The parent session has no validated SQL to refine"
  });
  assert.equal(insertedParams, null);
});

test("createQuerySession links a valid parent and normalizes its UUID", async () => {
  const result = await create(PARENT_ID.toUpperCase());

  assert.deepEqual(result, { ok: true, sessionId: NEW_SESSION_ID, parentSessionId: PARENT_ID });
  assert.deepEqual(insertedParams, [USER_ID, DATA_SOURCE_ID, "limit this to past 3 months", PARENT_ID]);
});

test("loadSessionRefinement returns null for a session without a parent", async () => {
  assert.equal(await loadSessionRefinement(NEW_SESSION_ID), null);
  assert.deepEqual(queries[0].params, [NEW_SESSION_ID, MAX_REFINEMENT_ANCESTORS]);
  assert.equal(queries.length, 1);
});

test("loadSessionRefinement orders questions oldest first and takes base SQL from the immediate parent", async () => {
  sessions.set(GRANDPARENT_ID, { user_id: USER_ID, data_source_id: DATA_SOURCE_ID, validatedSql: "SELECT 'grandparent'" });
  ancestorRows = [
    { id: GRANDPARENT_ID, question: "generate report for affiliates", depth: 2 },
    { id: PARENT_ID, question: "only those that ended contract with us", depth: 1 }
  ];

  const refinement = await loadSessionRefinement(NEW_SESSION_ID);

  assert.deepEqual(refinement, {
    parentSessionId: PARENT_ID,
    previousQuestions: ["generate report for affiliates", "only those that ended contract with us"],
    baseSql: "SELECT id FROM public.affiliates LIMIT 100"
  });
  assert.match(queries[0].sql, /order by depth desc/);
  assert.match(queries[0].sql, /where ancestors\.depth < \$2/);
  assert.deepEqual(queries[1].params, [PARENT_ID]);
});
