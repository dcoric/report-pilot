import "./helpers/setupEnv";
import { test } from "node:test";
import assert from "node:assert/strict";

process.env.DATABASE_URL = process.env.DATABASE_URL || "postgresql://test:test@localhost:5432/test";

import {
  prepareQueryGenerationContext,
  type GenerationContextDependencies
} from "../src/services/queryGenerationContextService";
import type { TableCard } from "../src/services/schemaLinkingService";
import type { RagRetrievalDoc } from "../src/services/ragRetrieval";

const PAYMENT = "00000000-0000-4000-8000-000000000201";
const CUSTOMER = "00000000-0000-4000-8000-000000000202";

test("prepareQueryGenerationContext returns only expanded scoped context and relevant RAG", async () => {
  const payment = card(PAYMENT, "payment", ["Revenue"]);
  const customer = card(CUSTOMER, "customer", ["Customer"]);
  const docs = [rag("payment-doc", "schema", PAYMENT, 2), rag("customer-doc", "schema", CUSTOMER, 1), rag("policy-doc", "policy", "note", 0.8)];
  const dependencies = baseDependencies([payment, customer], docs);

  const result = await prepareQueryGenerationContext({
    dataSourceId: "source",
    question: "Total revenue",
    finalRagLimit: 5
  }, dependencies);

  assert.equal(result.ok, true);
  if (result.ok) {
    assert.deepEqual(result.context.schemaObjects.map((object) => object.id), [PAYMENT]);
    assert.deepEqual(result.ragDocuments.map((doc) => doc.id), ["payment-doc", "policy-doc"]);
    assert.equal(result.diagnostics.candidates[0].id, PAYMENT);
  }
});

test("prepareQueryGenerationContext fails before the linker when no candidates match", async () => {
  let linkerCalled = false;
  const dependencies = baseDependencies([card(PAYMENT, "payment")], []);
  dependencies.linkTablesWithRouting = async () => {
    linkerCalled = true;
    throw new Error("must not be called");
  };

  const result = await prepareQueryGenerationContext({
    dataSourceId: "source",
    question: "Weather forecast"
  }, dependencies);

  assert.equal(result.ok, false);
  if (result.ok === false) {
    assert.equal(result.code, "no_schema_candidates");
  }
  assert.equal(linkerCalled, false);
});

test("prepareQueryGenerationContext surfaces graph ambiguity instead of generating", async () => {
  const dependencies = baseDependencies([card(PAYMENT, "payment", ["Revenue"])], []);
  dependencies.loadExpandedSchemaContext = async () => ({
    graph: { nodes: [], edges: [] },
    expansion: {
      status: "ambiguous",
      core_object_ids: [PAYMENT],
      object_ids: [PAYMENT],
      connector_object_ids: [],
      edges: [],
      paths: [],
      ambiguities: [{ target_object_id: CUSTOMER, alternatives: [] }],
      unresolved_object_ids: []
    },
    context: null
  });

  const result = await prepareQueryGenerationContext({
    dataSourceId: "source",
    question: "Revenue"
  }, dependencies);

  assert.equal(result.ok, false);
  if (result.ok === false) {
    assert.equal(result.code, "schema_linking_ambiguous");
  }
});

function baseDependencies(cards: TableCard[], docs: RagRetrievalDoc[]): GenerationContextDependencies {
  return {
    loadTableCards: async () => cards,
    retrieveRagContext: async () => docs,
    linkTablesWithRouting: async ({ candidates }) => ({
      selection: {
        table_ids: [candidates[0].id],
        concepts: ["revenue"],
        reason: "highest relevant candidate"
      },
      status: "success",
      provider: "openai",
      model: "test-model",
      attempts: [],
      fallback_reason: null,
      prompt_version: "v3-schema-linker",
      prompt_chars: 500
    }),
    loadExpandedSchemaContext: async (_dataSourceId, coreIds) => ({
      graph: { nodes: [], edges: [] },
      expansion: {
        status: "complete",
        core_object_ids: coreIds,
        object_ids: coreIds,
        connector_object_ids: [],
        edges: [],
        paths: [],
        ambiguities: [],
        unresolved_object_ids: []
      },
      context: {
        schemaObjects: cards
          .filter((item) => coreIds.includes(item.id))
          .map((item) => ({ id: item.id, schema_name: item.schema_name, object_name: item.object_name, object_type: item.object_type })),
        columns: [{ schema_name: "public", object_name: "payment", column_name: "amount", data_type: "numeric" }],
        semanticEntities: [],
        metricDefinitions: [],
        joinPolicies: [],
        ragNotes: []
      }
    })
  };
}

function card(id: string, objectName: string, aliases: string[] = []): TableCard {
  return {
    id,
    schema_name: "public",
    object_name: objectName,
    object_type: "table",
    description: null,
    primary_keys: [],
    join_columns: [],
    relationships: [],
    approved_join_refs: [],
    semantic_aliases: aliases,
    synonyms: []
  };
}

function rag(id: string, docType: string, refId: string, score: number): RagRetrievalDoc {
  return {
    id,
    doc_type: docType,
    ref_id: refId,
    content: `${docType} context`,
    metadata_json: null,
    vector_json: null,
    score,
    rerank_score: score,
    embedding_model: "test"
  };
}
