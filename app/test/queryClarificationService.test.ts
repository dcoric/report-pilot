import "./helpers/setupEnv";
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  buildCandidateClarification,
  buildJoinPathClarification,
  findCandidateIdByOptionId
} from "../src/services/queryClarificationService";
import type { SchemaExpansion, SchemaGraphEdge, SchemaPath } from "../src/services/schemaGraphService";
import type { TableCandidate } from "../src/services/schemaLinkingService";

test("join-path clarification produces stable, concise, and prompt-safe options", () => {
  const directEdge = edge("direct", "orders", "customers", "public.orders", "public.customers");
  const orderAccount = edge("order-account", "orders", "accounts", "public.orders", "public.accounts");
  const accountCustomer = edge("account-customer", "accounts", "customers", "public.accounts", "public.customers");
  const direct = path(["orders", "customers"], [directEdge]);
  const viaAccount = path(["orders", "accounts", "customers"], [orderAccount, accountCustomer]);
  const expansion = ambiguousExpansion([viaAccount, direct]);

  const clarification = buildJoinPathClarification(expansion);
  const reversed = buildJoinPathClarification(ambiguousExpansion([direct, viaAccount]));

  assert.ok(clarification);
  assert.deepEqual(clarification, reversed);
  assert.equal(clarification.kind, "join_path");
  assert.equal(clarification.options.length, 2);
  assert.deepEqual(clarification.options.map((option) => option.label), [
    "Join through public.accounts",
    "Use schema relationship (option 2)"
  ]);
  assert.deepEqual(clarification.options[0].table_refs, [
    "public.orders",
    "public.accounts",
    "public.customers"
  ]);
  assert.doesNotMatch(JSON.stringify(clarification), /orders\.account_id|customers\.id/);
});

test("clarification is absent when expansion is not ambiguous", () => {
  assert.equal(buildJoinPathClarification({
    ...ambiguousExpansion([]),
    status: "complete"
  }), null);
});

test("duplicate unqualified table names produce deterministic table choices", () => {
  const candidates = [
    candidate("sales-orders", "sales", "orders"),
    candidate("archive-orders", "archive", "orders")
  ];

  const ambiguity = buildCandidateClarification("Orders last month", candidates);

  assert.equal(ambiguity?.clarification.kind, "table");
  assert.deepEqual(ambiguity?.clarification.options.map((option) => option.label), [
    "Use archive.orders",
    "Use sales.orders"
  ]);
  assert.equal(
    findCandidateIdByOptionId(ambiguity!, ambiguity!.clarification.options[1].id),
    "sales-orders"
  );
  assert.equal(buildCandidateClarification("Sales orders last month", candidates), null);
});

test("an exact business alias across tables produces metric choices unless the table is named", () => {
  const candidates = [
    candidate("payments", "finance", "payment", ["Net Revenue"]),
    candidate("invoices", "sales", "invoice", ["Net Revenue"])
  ];

  const ambiguity = buildCandidateClarification("Show net revenue", candidates);

  assert.equal(ambiguity?.clarification.kind, "metric");
  assert.deepEqual(ambiguity?.clarification.options.map((option) => option.label), [
    "Use Net Revenue from finance.payment",
    "Use Net Revenue from sales.invoice"
  ]);
  assert.equal(buildCandidateClarification("Show payment net revenue", candidates), null);
});

function ambiguousExpansion(alternatives: SchemaPath[]): SchemaExpansion {
  return {
    status: "ambiguous",
    core_object_ids: ["orders", "customers"],
    object_ids: ["orders", "customers"],
    connector_object_ids: [],
    edges: [],
    paths: [],
    ambiguities: [{ target_object_id: "customers", alternatives }],
    unresolved_object_ids: []
  };
}

function path(objectIds: string[], edges: SchemaGraphEdge[]): SchemaPath {
  return {
    object_ids: objectIds,
    edge_ids: edges.map((item) => item.id),
    edges,
    approved_policy_count: 0
  };
}

function edge(
  id: string,
  leftObjectId: string,
  rightObjectId: string,
  leftRef: string,
  rightRef: string
): SchemaGraphEdge {
  return {
    id,
    left_object_id: leftObjectId,
    right_object_id: rightObjectId,
    left_ref: leftRef,
    right_ref: rightRef,
    source: "relationship",
    join_type: "INNER",
    on_clause: "orders.account_id = customers.id",
    relationship_type: "many_to_one"
  };
}

function candidate(
  id: string,
  schemaName: string,
  objectName: string,
  aliases: string[] = []
): TableCandidate {
  return {
    id,
    schema_name: schemaName,
    object_name: objectName,
    object_type: "table",
    description: null,
    primary_keys: [],
    join_columns: [],
    relationships: [],
    approved_join_refs: [],
    semantic_aliases: aliases,
    synonyms: [],
    score: 10,
    lexical_score: 10,
    rag_score: 0,
    matched_terms: []
  };
}
