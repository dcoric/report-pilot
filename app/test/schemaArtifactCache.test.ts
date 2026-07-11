import "./helpers/setupEnv";
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  clearSchemaArtifactCache,
  getOrLoadSchemaArtifact,
  invalidateSchemaArtifacts
} from "../src/services/schemaArtifactCache";
import ragService = require("../src/services/ragService");

const DATA_SOURCE_ID = "00000000-0000-4000-8000-000000000111";

test("schema artifacts are reused only within the same datasource version", async () => {
  clearSchemaArtifactCache();
  let loads = 0;
  const load = async () => ({ load: ++loads });

  const first = await getOrLoadSchemaArtifact("table_cards", DATA_SOURCE_ID, 1, load);
  const cached = await getOrLoadSchemaArtifact("table_cards", DATA_SOURCE_ID, 1, load);
  const nextVersion = await getOrLoadSchemaArtifact("table_cards", DATA_SOURCE_ID, 2, load);

  assert.equal(first, cached);
  assert.equal(first.load, 1);
  assert.equal(nextVersion.load, 2);
});

test("explicit datasource invalidation removes all artifact kinds", async () => {
  clearSchemaArtifactCache();
  let loads = 0;
  const load = async () => ({ load: ++loads });
  await getOrLoadSchemaArtifact("table_cards", DATA_SOURCE_ID, 1, load);
  await getOrLoadSchemaArtifact("schema_graph", DATA_SOURCE_ID, 1, load);

  assert.equal(invalidateSchemaArtifacts(DATA_SOURCE_ID), 2);
  const reloaded = await getOrLoadSchemaArtifact("table_cards", DATA_SOURCE_ID, 1, load);
  assert.equal(reloaded.load, 3);
});

test("reindex triggers invalidate artifacts before background work starts", async () => {
  clearSchemaArtifactCache();
  let loads = 0;
  const load = async () => ({ load: ++loads });
  await getOrLoadSchemaArtifact("schema_graph", DATA_SOURCE_ID, 1, load);
  const originalReindex = ragService.reindexRagDocuments;
  ragService.reindexRagDocuments = async () => ({
    data_source_id: DATA_SOURCE_ID,
    documents_indexed: 0,
    embedding_model: "test",
    schema_version: 2
  });

  try {
    ragService.triggerRagReindexAsync(DATA_SOURCE_ID);
    const reloaded = await getOrLoadSchemaArtifact("schema_graph", DATA_SOURCE_ID, 1, load);
    assert.equal(reloaded.load, 2);
    await new Promise<void>((resolve) => setImmediate(resolve));
  } finally {
    ragService.reindexRagDocuments = originalReindex;
  }
});

test("failed artifact loads are not cached", async () => {
  clearSchemaArtifactCache();
  let attempts = 0;
  const load = async () => {
    attempts += 1;
    throw new Error("load failed");
  };

  await assert.rejects(getOrLoadSchemaArtifact("table_cards", DATA_SOURCE_ID, 1, load));
  await assert.rejects(getOrLoadSchemaArtifact("table_cards", DATA_SOURCE_ID, 1, load));
  assert.equal(attempts, 2);
});
