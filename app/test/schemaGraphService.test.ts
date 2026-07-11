import "./helpers/setupEnv";
import { after, before, test } from "node:test";
import assert from "node:assert/strict";

process.env.DATABASE_URL = process.env.DATABASE_URL || "postgresql://test:test@localhost:5432/test";

import appDb = require("../src/lib/appDb");
import {
  expandSchemaGraph,
  loadExpandedSchemaContext,
  loadResolvedSchemaContext,
  type SchemaGraph,
  type SchemaGraphEdge,
  type SchemaGraphNode
} from "../src/services/schemaGraphService";
import { clearSchemaArtifactCache } from "../src/services/schemaArtifactCache";

const DATA_SOURCE_ID = "00000000-0000-4000-8000-000000000111";
const A = "00000000-0000-4000-8000-000000000201";
const B = "00000000-0000-4000-8000-000000000202";
const C = "00000000-0000-4000-8000-000000000203";
const D = "00000000-0000-4000-8000-000000000204";

let originalQuery: typeof appDb.query;

before(() => {
  originalQuery = appDb.query;
});

after(() => {
  appDb.query = originalQuery;
});

test("expandSchemaGraph uses an approved direct policy over an introspected relationship", () => {
  const graph = makeGraph(
    [node(A, "payment"), node(B, "customer")],
    [
      edge("relationship:ab", A, B, "relationship"),
      edge("policy:ab", A, B, "approved_policy", "payment.customer_id = customer.customer_id")
    ]
  );

  const expansion = expandSchemaGraph(graph, [A, B]);

  assert.equal(expansion.status, "complete");
  assert.deepEqual(expansion.object_ids, [A, B]);
  assert.deepEqual(expansion.edges.map((item) => item.id), ["policy:ab"]);
  assert.equal(expansion.edges[0].on_clause, "payment.customer_id = customer.customer_id");
});

test("expandSchemaGraph adds a bridge table and its join predicates", () => {
  const graph = makeGraph(
    [node(A, "payment"), node(B, "rental"), node(C, "inventory")],
    [edge("ab", A, B), edge("bc", B, C)]
  );

  const expansion = expandSchemaGraph(graph, [A, C], { maxIntermediateHops: 1 });

  assert.equal(expansion.status, "complete");
  assert.deepEqual(expansion.object_ids, [A, C, B]);
  assert.deepEqual(expansion.connector_object_ids, [B]);
  assert.deepEqual(expansion.paths[0].edge_ids, ["ab", "bc"]);
  assert.equal(expansion.edges.length, 2);
});

test("expandSchemaGraph reports equally good paths as ambiguity", () => {
  const graph = makeGraph(
    [node(A, "orders"), node(B, "customer_bridge"), node(C, "account_bridge"), node(D, "customer")],
    [edge("ab", A, B), edge("bd", B, D), edge("ac", A, C), edge("cd", C, D)]
  );

  const expansion = expandSchemaGraph(graph, [A, D], { maxIntermediateHops: 1 });

  assert.equal(expansion.status, "ambiguous");
  assert.deepEqual(expansion.object_ids, [A]);
  assert.equal(expansion.ambiguities.length, 1);
  assert.deepEqual(
    expansion.ambiguities[0].alternatives.map((path) => path.object_ids),
    [[A, B, D], [A, C, D]]
  );
});

test("expandSchemaGraph distinguishes disconnected and hop-limited targets", () => {
  const graph = makeGraph(
    [node(A, "a"), node(B, "b"), node(C, "c"), node(D, "isolated")],
    [edge("ab", A, B), edge("bc", B, C)]
  );

  const hopLimited = expandSchemaGraph(graph, [A, C], { maxIntermediateHops: 0 });
  const disconnected = expandSchemaGraph(graph, [A, D], { maxIntermediateHops: 4 });

  assert.equal(hopLimited.status, "disconnected");
  assert.deepEqual(hopLimited.unresolved_object_ids, [C]);
  assert.equal(disconnected.status, "disconnected");
  assert.deepEqual(disconnected.unresolved_object_ids, [D]);
});

test("expandSchemaGraph handles cycles without revisiting objects", () => {
  const graph = makeGraph(
    [node(A, "a"), node(B, "b"), node(C, "c"), node(D, "d")],
    [edge("ab", A, B), edge("bc", B, C), edge("ca", C, A), edge("cd", C, D)]
  );

  const expansion = expandSchemaGraph(graph, [A, D], { maxIntermediateHops: 2 });

  assert.equal(expansion.status, "complete");
  assert.equal(new Set(expansion.paths[0].object_ids).size, expansion.paths[0].object_ids.length);
  assert.deepEqual(expansion.paths[0].object_ids, [A, C, D]);
});

test("loadExpandedSchemaContext loads full columns for core and connector tables", async () => {
  clearSchemaArtifactCache();
  const scopedColumnCalls: unknown[][] = [];
  appDb.query = (async (sql: string, params: unknown[] = []) => {
    const normalized = normalizeSql(sql);
    if (normalized.includes("from rag_index_state")) {
      return result([{ schema_version: 1 }]);
    }
    if (normalized.includes("from schema_objects") && normalized.includes("object_type in")) {
      return result([
        { id: A, schema_name: "public", object_name: "payment", object_type: "table" },
        { id: B, schema_name: "public", object_name: "rental", object_type: "table" },
        { id: C, schema_name: "public", object_name: "inventory", object_type: "table" }
      ]);
    }
    if (normalized.includes("from relationships r")) {
      return result([
        relationship("ab", A, "payment", "rental_id", B, "rental", "rental_id"),
        relationship("bc", B, "rental", "inventory_id", C, "inventory", "inventory_id")
      ]);
    }
    if (normalized.includes("from join_policies")) {
      return result([]);
    }
    if (normalized.includes("from columns c")) {
      scopedColumnCalls.push(params);
      return result(Array.from({ length: 300 }, (_, index) => ({
        schema_name: "public",
        object_name: index < 100 ? "payment" : index < 200 ? "rental" : "inventory",
        column_name: `column_${index}`,
        data_type: "text"
      })));
    }
    if (normalized.includes("from semantic_entities")
      || normalized.includes("from metric_definitions")
      || normalized.includes("from rag_notes")) {
      return result([]);
    }
    throw new Error(`Unexpected SQL: ${normalized}`);
  }) as typeof appDb.query;

  const resultWithContext = await loadExpandedSchemaContext(DATA_SOURCE_ID, [A, C], { maxIntermediateHops: 1 });

  assert.equal(resultWithContext.expansion.status, "complete");
  assert.deepEqual(resultWithContext.expansion.connector_object_ids, [B]);
  assert.equal(resultWithContext.context?.columns.length, 300);
  assert.deepEqual(
    resultWithContext.context?.joinPolicies.map((policy) => policy.id),
    ["relationship:ab", "relationship:bc"]
  );
  assert.deepEqual(scopedColumnCalls[0], [DATA_SOURCE_ID, [A, C, B]]);
  assert.deepEqual(
    resultWithContext.expansion.edges.map((item) => item.on_clause),
    [
      "public.payment.rental_id = public.rental.rental_id",
      "public.rental.inventory_id = public.inventory.inventory_id"
    ]
  );
});

test("loadResolvedSchemaContext applies the selected path and scopes its join policies", async () => {
  const graph = makeGraph(
    [node(A, "orders"), node(B, "customer_bridge"), node(C, "account_bridge"), node(D, "customer")],
    [edge("ab", A, B), edge("bd", B, D), edge("ac", A, C), edge("cd", C, D)]
  );
  const expansion = expandSchemaGraph(graph, [A, D], { maxIntermediateHops: 1 });
  const selectedPath = expansion.ambiguities[0].alternatives[1];
  appDb.query = (async (sql: string, params: unknown[] = []) => {
    const normalized = normalizeSql(sql);
    if (normalized.includes("from schema_objects") && normalized.includes("object_type in")) {
      return result(graph.nodes
        .filter((item) => (params[1] as string[]).includes(item.id))
        .map((item) => ({
          id: item.id,
          schema_name: item.schema_name,
          object_name: item.object_name,
          object_type: item.object_type
        })));
    }
    if (normalized.includes("from columns c")
      || normalized.includes("from semantic_entities")
      || normalized.includes("from metric_definitions")
      || normalized.includes("from join_policies")
      || normalized.includes("from rag_notes")) {
      return result([]);
    }
    throw new Error(`Unexpected SQL: ${normalized}`);
  }) as typeof appDb.query;

  const resolved = await loadResolvedSchemaContext(DATA_SOURCE_ID, { graph, expansion, context: null }, selectedPath);

  assert.equal(resolved.expansion.status, "complete");
  assert.deepEqual(resolved.expansion.object_ids, [A, C, D]);
  assert.deepEqual(resolved.expansion.connector_object_ids, [C]);
  assert.deepEqual(resolved.context?.joinPolicies.map((policy) => policy.id), ["ac", "cd"]);
});

function node(id: string, objectName: string): SchemaGraphNode {
  return {
    id,
    schema_name: "public",
    object_name: objectName,
    object_type: "table",
    ref: `public.${objectName}`
  };
}

function edge(
  id: string,
  leftId: string,
  rightId: string,
  source: SchemaGraphEdge["source"] = "relationship",
  onClause = `${leftId}.id = ${rightId}.id`
): SchemaGraphEdge {
  return {
    id,
    left_object_id: leftId,
    right_object_id: rightId,
    left_ref: leftId,
    right_ref: rightId,
    source,
    join_type: "INNER",
    on_clause: onClause,
    relationship_type: source === "relationship" ? "fk" : null
  };
}

function makeGraph(nodes: SchemaGraphNode[], edges: SchemaGraphEdge[]): SchemaGraph {
  return { nodes, edges };
}

function relationship(
  id: string,
  fromId: string,
  fromObject: string,
  fromColumn: string,
  toId: string,
  toObject: string,
  toColumn: string
) {
  return {
    id,
    from_object_id: fromId,
    from_column: fromColumn,
    from_schema: "public",
    from_object: fromObject,
    to_object_id: toId,
    to_column: toColumn,
    to_schema: "public",
    to_object: toObject,
    relationship_type: "fk"
  };
}

function normalizeSql(sql: string): string {
  return sql.replace(/\s+/g, " ").trim().toLowerCase();
}

function result<T>(rows: T[]): { rows: T[]; rowCount: number } {
  return { rows, rowCount: rows.length };
}
