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

test("prepareQueryGenerationContext reserves prompt space for compatible ranked examples", async () => {
  const payment = card(PAYMENT, "payment", ["Revenue"]);
  const docs = [
    rag("payment-doc", "schema", PAYMENT, 2),
    exampleRag("compatible", "public.payment", 0.9),
    exampleRag("incompatible", "public.inventory", 1),
    rag("policy-doc", "policy", "note", 0.8)
  ];
  const dependencies = baseDependencies([payment], docs);

  const result = await prepareQueryGenerationContext({
    dataSourceId: "source",
    question: "Total revenue",
    finalRagLimit: 3
  }, dependencies);

  assert.equal(result.ok, true);
  if (result.ok) {
    assert.deepEqual(result.ragDocuments.map((document) => document.id), [
      "payment-doc",
      "compatible",
      "policy-doc"
    ]);
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
  const dependencies = baseDependencies([
    card(PAYMENT, "payment", ["Revenue"]),
    card(CUSTOMER, "customer")
  ], []);
  dependencies.loadExpandedSchemaContext = async () => ({
    graph: { nodes: [], edges: [] },
    expansion: {
      status: "ambiguous",
      core_object_ids: [PAYMENT, CUSTOMER],
      object_ids: [PAYMENT],
      connector_object_ids: [],
      edges: [],
      paths: [],
      ambiguities: [{
        target_object_id: CUSTOMER,
        alternatives: [
          ambiguityPath("edge-a"),
          ambiguityPath("edge-b")
        ]
      }],
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
    assert.equal(result.clarification?.kind, "join_path");
    assert.equal(result.clarification?.options.length, 2);
    const resumed = await prepareQueryGenerationContext({
      dataSourceId: "source",
      question: "Revenue",
      clarificationOptionId: result.clarification!.options[0].id
    }, dependencies);
    assert.equal(resumed.ok, true);
  }
});

test("prepareQueryGenerationContext rejects stale clarification option IDs", async () => {
  const dependencies = baseDependencies([
    card(PAYMENT, "payment", ["Revenue"]),
    card(CUSTOMER, "customer")
  ], []);
  dependencies.loadExpandedSchemaContext = async () => ({
    graph: { nodes: [], edges: [] },
    expansion: {
      status: "ambiguous",
      core_object_ids: [PAYMENT, CUSTOMER],
      object_ids: [PAYMENT],
      connector_object_ids: [],
      edges: [],
      paths: [],
      ambiguities: [{
        target_object_id: CUSTOMER,
        alternatives: [ambiguityPath("edge-a"), ambiguityPath("edge-b")]
      }],
      unresolved_object_ids: []
    },
    context: null
  });

  const result = await prepareQueryGenerationContext({
    dataSourceId: "source",
    question: "Revenue",
    clarificationOptionId: "join_path_000000000000"
  }, dependencies);

  assert.equal(result.ok, false);
  if (result.ok === false) {
    assert.equal(result.code, "clarification_option_invalid");
    assert.equal(result.clarification?.options.length, 2);
  }
});

test("prepareQueryGenerationContext scopes linking to the selected duplicate table", async () => {
  const archiveOrders = { ...card("archive-orders", "orders"), schema_name: "archive" };
  const salesOrders = { ...card("sales-orders", "orders"), schema_name: "sales" };
  const dependencies = baseDependencies([archiveOrders, salesOrders], []);

  const ambiguous = await prepareQueryGenerationContext({
    dataSourceId: "source",
    question: "Orders last month"
  }, dependencies);

  assert.equal(ambiguous.ok, false);
  if (ambiguous.ok === false) {
    assert.equal(ambiguous.clarification?.kind, "table");
    const salesOption = ambiguous.clarification!.options.find((option) => option.label === "Use sales.orders");
    assert.ok(salesOption);
    const resolved = await prepareQueryGenerationContext({
      dataSourceId: "source",
      question: "Orders last month",
      clarificationOptionId: salesOption.id
    }, dependencies);
    assert.equal(resolved.ok, true);
    if (resolved.ok) {
      assert.deepEqual(resolved.context.schemaObjects.map((object) => object.id), ["sales-orders"]);
    }
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
    }),
    loadResolvedSchemaContext: async (_dataSourceId, expanded, selectedPath) => {
      const objectIds = [...new Set([...expanded.expansion.object_ids, ...selectedPath.object_ids])];
      return {
        graph: expanded.graph,
        expansion: {
          ...expanded.expansion,
          status: "complete" as const,
          object_ids: objectIds,
          connector_object_ids: objectIds.filter((id) => !expanded.expansion.core_object_ids.includes(id)),
          edges: selectedPath.edges,
          paths: [selectedPath],
          ambiguities: []
        },
        context: {
          schemaObjects: cards
            .filter((item) => objectIds.includes(item.id))
            .map((item) => ({ id: item.id, schema_name: item.schema_name, object_name: item.object_name, object_type: item.object_type })),
          columns: [{ schema_name: "public", object_name: "payment", column_name: "amount", data_type: "numeric" }],
          semanticEntities: [],
          metricDefinitions: [],
          joinPolicies: selectedPath.edges.map((edge) => ({
            id: edge.id,
            left_ref: edge.left_ref,
            right_ref: edge.right_ref,
            join_type: edge.join_type,
            on_clause: edge.on_clause
          })),
          ragNotes: []
        }
      };
    }
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

function exampleRag(id: string, schemaRef: string, quality: number): RagRetrievalDoc {
  return {
    ...rag(id, "example", id, 1),
    content: `example question Revenue\nexample sql SELECT amount FROM ${schemaRef}`,
    metadata_json: {
      source: "manual",
      quality_score: quality,
      validation_state: "validated",
      schema_refs: [schemaRef]
    }
  };
}

function ambiguityPath(edgeId: string) {
  const edge = {
    id: edgeId,
    left_object_id: PAYMENT,
    right_object_id: CUSTOMER,
    left_ref: "public.payment",
    right_ref: "public.customer",
    source: "relationship" as const,
    join_type: "INNER",
    on_clause: "public.payment.customer_id = public.customer.id",
    relationship_type: "many_to_one"
  };
  return {
    object_ids: [PAYMENT, CUSTOMER],
    edge_ids: [edge.id],
    edges: [edge],
    approved_policy_count: 0
  };
}
