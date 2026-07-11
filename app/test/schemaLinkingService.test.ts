import "./helpers/setupEnv";
import { after, before, test } from "node:test";
import assert from "node:assert/strict";

process.env.DATABASE_URL = process.env.DATABASE_URL || "postgresql://test:test@localhost:5432/test";

import appDb = require("../src/lib/appDb");
import {
  loadTableCards,
  rankTableCards,
  type TableCard
} from "../src/services/schemaLinkingService";
import { loadScopedQueryContext } from "../src/services/queryOrchestrationStore";
import type { RagRetrievalDoc } from "../src/services/ragRetrieval";
import { clearSchemaArtifactCache } from "../src/services/schemaArtifactCache";

const DATA_SOURCE_ID = "00000000-0000-4000-8000-000000000111";
const PAYMENT_ID = "00000000-0000-4000-8000-000000000201";
const CUSTOMER_ID = "00000000-0000-4000-8000-000000000202";

let originalQuery: typeof appDb.query;

before(() => {
  originalQuery = appDb.query;
});

after(() => {
  appDb.query = originalQuery;
});

test("rankTableCards finds a semantic match among a large distractor schema", () => {
  const distractors = Array.from({ length: 1000 }, (_, index) =>
    card(`table-${index}`, `archive_${String(index).padStart(4, "0")}`));
  const payment = card(PAYMENT_ID, "payment", {
    description: "Transactions received from customers",
    semantic_aliases: ["Revenue"],
    synonyms: [{ term: "sales", weight: 1.5 }]
  });

  const candidates = rankTableCards("Show revenue by month", [...distractors, payment], [], 5);

  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].id, PAYMENT_ID);
  assert.ok(candidates[0].score > 0);
  assert.deepEqual(candidates[0].matched_terms, ["revenue"]);
});

test("rankTableCards uses schema RAG scores and applies a deterministic limit", () => {
  const cards = [card("b", "beta"), card("a", "alpha"), card("c", "gamma")];
  const ragDocuments = [
    ragDoc("b", 0.7),
    ragDoc("a", 0.7),
    ragDoc("c", 0.2)
  ];

  const candidates = rankTableCards("business concept with no lexical match", cards, ragDocuments, 2);

  assert.deepEqual(candidates.map((candidate) => candidate.id), ["a", "b"]);
  assert.deepEqual(candidates.map((candidate) => candidate.rag_score), [0.7, 0.7]);
});

test("rankTableCards returns no weak fill candidates for an empty or unmatched question", () => {
  const cards = [card(PAYMENT_ID, "payment")];

  assert.deepEqual(rankTableCards("", cards), []);
  assert.deepEqual(rankTableCards("weather forecast", cards), []);
});

test("loadTableCards retains keys, both relationship directions, aliases, synonyms, and approved endpoints", async () => {
  clearSchemaArtifactCache();
  appDb.query = (async (sql: string) => {
    const normalized = normalizeSql(sql);
    if (normalized.includes("from rag_index_state")) {
      return result([{ schema_version: 1 }]);
    }
    if (normalized.includes("from schema_objects") && normalized.includes("object_type in")) {
      return result([
        {
          id: PAYMENT_ID,
          schema_name: "public",
          object_name: "payment",
          object_type: "table",
          description: "Customer payments"
        },
        {
          id: CUSTOMER_ID,
          schema_name: "public",
          object_name: "customer",
          object_type: "table",
          description: "Customers"
        }
      ]);
    }
    if (normalized.includes("c.is_pk = true")) {
      return result([{ schema_object_id: PAYMENT_ID, column_name: "payment_id" }]);
    }
    if (normalized.includes("from relationships")) {
      return result([{
        from_object_id: PAYMENT_ID,
        from_column: "customer_id",
        from_schema: "public",
        from_object: "payment",
        to_object_id: CUSTOMER_ID,
        to_column: "customer_id",
        to_schema: "public",
        to_object: "customer",
        relationship_type: "fk"
      }]);
    }
    if (normalized.includes("from semantic_entities")) {
      return result([{ target_ref: "public.payment", business_name: "Revenue" }]);
    }
    if (normalized.includes("from synonyms")) {
      return result([{ term: "sales", maps_to_ref: "public.payment.amount", weight: "1.5" }]);
    }
    if (normalized.includes("from join_policies")) {
      return result([{ left_ref: "public.payment", right_ref: "public.customer" }]);
    }
    throw new Error(`Unexpected SQL: ${normalized}`);
  }) as typeof appDb.query;

  const cards = await loadTableCards(DATA_SOURCE_ID);
  const payment = cards.find((candidate) => candidate.id === PAYMENT_ID);
  const customer = cards.find((candidate) => candidate.id === CUSTOMER_ID);

  assert.deepEqual(payment?.primary_keys, ["payment_id"]);
  assert.deepEqual(payment?.join_columns, ["customer_id"]);
  assert.deepEqual(payment?.semantic_aliases, ["Revenue"]);
  assert.deepEqual(payment?.synonyms, [{ term: "sales", weight: 1.5 }]);
  assert.deepEqual(payment?.approved_join_refs, ["public.customer"]);
  assert.deepEqual(payment?.relationships, [{
    column: "customer_id",
    related_ref: "public.customer",
    related_column: "customer_id",
    direction: "outbound",
    relationship_type: "fk"
  }]);
  assert.deepEqual(customer?.relationships[0]?.direction, "inbound");
});

test("loadScopedQueryContext loads every column for selected objects and filters semantic context", async () => {
  const calls: Array<{ sql: string; params: unknown[] }> = [];
  appDb.query = (async (sql: string, params: unknown[] = []) => {
    const normalized = normalizeSql(sql);
    calls.push({ sql: normalized, params });
    if (normalized.includes("from schema_objects") && normalized.includes("object_type in")) {
      return result([{
        id: PAYMENT_ID,
        schema_name: "public",
        object_name: "payment",
        object_type: "table"
      }]);
    }
    if (normalized.includes("from columns c")) {
      return result(Array.from({ length: 250 }, (_, ordinal) => ({
        schema_name: "public",
        object_name: "payment",
        column_name: `column_${ordinal}`,
        data_type: "text"
      })));
    }
    if (normalized.includes("from semantic_entities")) {
      return result([
        { id: "semantic-payment", entity_type: "table", target_ref: "public.payment", business_name: "Revenue" },
        { id: "semantic-customer", entity_type: "table", target_ref: "public.customer", business_name: "Customers" }
      ]);
    }
    if (normalized.includes("from metric_definitions")) {
      return result([
        { id: "metric-payment", semantic_entity_id: "semantic-payment", sql_expression: "sum(amount)", grain: null, business_name: "Revenue" },
        { id: "metric-customer", semantic_entity_id: "semantic-customer", sql_expression: "count(*)", grain: null, business_name: "Customers" }
      ]);
    }
    if (normalized.includes("from join_policies")) {
      return result([
        { id: "join-self", left_ref: "public.payment", right_ref: "public.payment", join_type: "inner", on_clause: "true" },
        { id: "join-other", left_ref: "public.payment", right_ref: "public.customer", join_type: "inner", on_clause: "true" }
      ]);
    }
    if (normalized.includes("from rag_notes")) {
      return result([{ id: "note", title: "Policy", content: "Exclude tests" }]);
    }
    throw new Error(`Unexpected SQL: ${normalized}`);
  }) as typeof appDb.query;

  const context = await loadScopedQueryContext(DATA_SOURCE_ID, [PAYMENT_ID, PAYMENT_ID]);

  assert.equal(context.schemaObjects.length, 1);
  assert.equal(context.columns.length, 250);
  assert.deepEqual(context.semanticEntities.map((entity) => entity.id), ["semantic-payment"]);
  assert.deepEqual(context.metricDefinitions.map((metric) => metric.id), ["metric-payment"]);
  assert.deepEqual(context.joinPolicies.map((join) => join.id), ["join-self"]);
  assert.equal(context.ragNotes.length, 1);
  assert.ok(calls.slice(0, 2).every((call) => call.sql.includes("any($2::uuid[])")));
  assert.deepEqual(calls[0].params, [DATA_SOURCE_ID, [PAYMENT_ID]]);
});

function card(id: string, objectName: string, overrides: Partial<TableCard> = {}): TableCard {
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
    semantic_aliases: [],
    synonyms: [],
    ...overrides
  };
}

function ragDoc(refId: string, score: number): RagRetrievalDoc {
  return {
    id: `rag-${refId}`,
    doc_type: "schema",
    ref_id: refId,
    content: "schema card",
    metadata_json: null,
    vector_json: null,
    score,
    rerank_score: score,
    embedding_model: "test"
  };
}

function normalizeSql(sql: string): string {
  return sql.replace(/\s+/g, " ").trim().toLowerCase();
}

function result<T>(rows: T[]): { rows: T[]; rowCount: number } {
  return { rows, rowCount: rows.length };
}
