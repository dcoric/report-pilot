import "./helpers/setupEnv";
import { test } from "node:test";
import assert from "node:assert/strict";
import type { PoolClient } from "pg";

import appDb = require("../src/lib/appDb");
import {
  cancelPendingClarification,
  recordPendingClarification,
  resolvePendingClarification
} from "../src/services/queryClarificationStore";

test("clarification store persists pending options and audits their resolution", async () => {
  const originalTransaction = appDb.withTransaction;
  const statements: Array<{ sql: string; params: unknown[] }> = [];
  const client = {
    query: async (sql: string, params: unknown[] = []) => {
      const normalized = sql.replace(/\s+/g, " ").trim().toLowerCase();
      statements.push({ sql: normalized, params });
      return {
        rowCount: normalized.startsWith("update query_clarifications") ? 1 : 0,
        rows: []
      };
    }
  } as unknown as PoolClient;
  appDb.withTransaction = (async <T>(callback: (transactionClient: PoolClient) => Promise<T>) => callback(client)) as typeof appDb.withTransaction;

  try {
    await recordPendingClarification("session-1", {
      kind: "join_path",
      message: "Choose a path",
      options: [
        { id: "join_path_111111111111", label: "One", description: "First", table_refs: ["public.a"] },
        { id: "join_path_222222222222", label: "Two", description: "Second", table_refs: ["public.b"] }
      ]
    });
    const resolved = await resolvePendingClarification("session-1", "join_path_111111111111");

    assert.equal(resolved, true);
    assert.ok(statements.some((entry) => entry.sql.includes("insert into query_clarifications")));
    assert.ok(statements.some((entry) => entry.sql.includes("status = 'awaiting_clarification'")));
    assert.ok(statements.some((entry) => entry.sql.includes("selected_option_id = $2")));
    assert.ok(statements.some((entry) => entry.sql.includes("status = 'created'")));
  } finally {
    appDb.withTransaction = originalTransaction;
  }
});

test("clarification store audits cancellation and updates the session state", async () => {
  const originalTransaction = appDb.withTransaction;
  const statements: string[] = [];
  const client = {
    query: async (sql: string) => {
      const normalized = sql.replace(/\s+/g, " ").trim().toLowerCase();
      statements.push(normalized);
      return { rowCount: 1, rows: [] };
    }
  } as unknown as PoolClient;
  appDb.withTransaction = (async <T>(callback: (transactionClient: PoolClient) => Promise<T>) => callback(client)) as typeof appDb.withTransaction;

  try {
    assert.equal(await cancelPendingClarification("session-1"), true);
    assert.ok(statements.some((statement) => statement.includes("set status = 'cancelled'")));
    assert.ok(statements.some((statement) => statement.includes("update query_sessions set status = 'cancelled'")));
  } finally {
    appDb.withTransaction = originalTransaction;
  }
});

test("clarification store accepts retrying an already resolved option", async () => {
  const originalTransaction = appDb.withTransaction;
  const client = {
    query: async (sql: string) => {
      const normalized = sql.replace(/\s+/g, " ").trim().toLowerCase();
      if (normalized.startsWith("update query_clarifications")) return { rowCount: 0, rows: [] };
      if (normalized.startsWith("select 1 from query_clarifications")) return { rowCount: 1, rows: [{ "?column?": 1 }] };
      return { rowCount: 1, rows: [] };
    }
  } as unknown as PoolClient;
  appDb.withTransaction = (async <T>(callback: (transactionClient: PoolClient) => Promise<T>) => callback(client)) as typeof appDb.withTransaction;

  try {
    assert.equal(await resolvePendingClarification("session-1", "join_path_111111111111"), true);
  } finally {
    appDb.withTransaction = originalTransaction;
  }
});
