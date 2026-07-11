import "./helpers/setupEnv";
import { test } from "node:test";
import assert from "node:assert/strict";
import type { PoolClient } from "pg";

import ragService = require("../src/services/ragService");

test("RAG reindex invalidation atomically advances the datasource schema version", async () => {
  let sql = "";
  let params: unknown[] = [];
  const client = {
    query: async (text: string, values: unknown[]) => {
      sql = text.replace(/\s+/g, " ").trim().toLowerCase();
      params = values;
      return { rowCount: 1, rows: [{ schema_version: "7" }] };
    }
  } as unknown as PoolClient;

  const version = await ragService.__private.advanceRagSchemaVersion(client, "source-1");

  assert.equal(version, 7);
  assert.match(sql, /on conflict \(data_source_id\) do update/);
  assert.match(sql, /schema_version = rag_index_state\.schema_version \+ 1/);
  assert.deepEqual(params, ["source-1"]);
});
