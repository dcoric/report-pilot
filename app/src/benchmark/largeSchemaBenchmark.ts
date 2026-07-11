import * as fs from "fs/promises";
import * as path from "path";
import { performance } from "perf_hooks";
import { buildSqlPrompt } from "../services/llmPromptBuilder";
import { expandSchemaGraph, type SchemaGraph, type SchemaGraphEdge, type SchemaGraphNode } from "../services/schemaGraphService";
import { rankTableCards, type TableCard } from "../services/schemaLinkingService";

export const DEFAULT_LARGE_SCHEMA_BENCHMARK_FILE = path.join(
  process.cwd(),
  "docs",
  "evals",
  "large-schema-linking-benchmark.json"
);

interface LargeSchemaCaseDefinition {
  id: string;
  question: string;
  expected_core_refs: string[];
  expected_path_refs: string[];
  expected_status: "complete" | "ambiguous";
  complexity: string;
}

interface LargeSchemaFixtureDefinition {
  version: string;
  distractor_table_count: number;
  distractor_columns_per_table: number;
  candidate_limit: number;
  legacy_table_limit: number;
  legacy_column_limit: number;
  cases: LargeSchemaCaseDefinition[];
}

interface SyntheticSchema {
  cards: TableCard[];
  graph: SchemaGraph;
  columns: Array<{ schema_name: string; object_name: string; column_name: string; data_type: string }>;
}

export interface LargeSchemaCaseResult {
  id: string;
  complexity: string;
  expected_status: string;
  legacy_global: {
    table_recall_at_40: number;
    join_path_correct: boolean;
    prompt_chars: number;
  };
  hierarchical: {
    table_recall_at_15: number;
    join_path_correct: boolean;
    expansion_status: string;
    prompt_chars: number | null;
    latency_ms: number;
  };
}

export interface LargeSchemaGateDiagnostic {
  id: string;
  stage: "schema_linking" | "prompt_construction";
  metric: string;
  actual: number;
  comparator: ">=" | ">" | "<" | "<=" | "=";
  target: number;
  passed: boolean;
}

export const LARGE_SCHEMA_THRESHOLDS = {
  table_recall_at_15: 0.95,
  join_path_accuracy: 1,
  max_p95_linking_latency_ms: 250
} as const;

export const LARGE_SCHEMA_SCALE_DISTRACTOR_COUNTS = [100, 300, 1000] as const;

export interface LargeSchemaScaleResult {
  distractor_table_count: number;
  table_count: number;
  column_count: number;
  table_recall_at_15: number;
  join_path_accuracy: number;
  max_candidate_count: number;
  p95_linking_latency_ms: number;
}

export interface LargeSchemaBenchmarkResult {
  version: string;
  schema: {
    table_count: number;
    column_count: number;
    distractor_table_count: number;
  };
  legacy_global: {
    table_recall_at_40: number;
    join_path_accuracy: number;
    average_prompt_chars: number;
  };
  hierarchical: {
    table_recall_at_15: number;
    join_path_accuracy: number;
    average_prompt_chars: number;
    p95_linking_latency_ms: number;
  };
  deltas: {
    table_recall: number;
    join_path_accuracy: number;
    average_prompt_chars: number;
  };
  release_gates: {
    table_recall_at_15_ge_95pct: boolean;
    join_path_accuracy_eq_100pct: boolean;
    improves_table_recall_over_legacy: boolean;
    prompt_chars_below_legacy: boolean;
    scale_recall_ge_95pct: boolean;
    scale_join_accuracy_eq_100pct: boolean;
    scale_candidate_count_bounded: boolean;
    scale_p95_linking_latency_le_250ms: boolean;
    all_passed: boolean;
  };
  gate_diagnostics: LargeSchemaGateDiagnostic[];
  scaling: LargeSchemaScaleResult[];
  cases: LargeSchemaCaseResult[];
}

export async function runLargeSchemaBenchmark(
  filePath: string = DEFAULT_LARGE_SCHEMA_BENCHMARK_FILE
): Promise<LargeSchemaBenchmarkResult> {
  const fixture = await readFixture(filePath);
  const schema = buildSyntheticSchema(fixture);
  const cardsByRef = new Map(schema.cards.map((card) => [tableRef(card), card]));
  const nodesByRef = new Map(schema.graph.nodes.map((node) => [node.ref, node]));
  const legacyObjects = schema.graph.nodes
    .slice()
    .sort((a, b) => a.ref.localeCompare(b.ref))
    .slice(0, fixture.legacy_table_limit);
  const legacyIds = new Set(legacyObjects.map((node) => node.id));
  const legacyColumns = schema.columns
    .slice()
    .sort(compareColumns)
    .slice(0, fixture.legacy_column_limit);
  const results: LargeSchemaCaseResult[] = [];

  for (const caseDef of fixture.cases) {
    const expectedCoreCards = caseDef.expected_core_refs.map((ref) => required(cardsByRef, ref));
    const expectedCoreIds = expectedCoreCards.map((card) => card.id);
    const startedAt = performance.now();
    const candidates = rankTableCards(caseDef.question, schema.cards, [], fixture.candidate_limit);
    const expansion = expandSchemaGraph(schema.graph, expectedCoreIds, {
      maxIntermediateHops: caseDef.complexity === "multi_hop" ? 3 : 2,
      maxAlternativePaths: 4
    });
    const linkingLatency = performance.now() - startedAt;
    const candidateRefs = new Set(candidates.map(tableRef));
    const expandedRefs = new Set(expansion.object_ids.map((id) => schema.graph.nodes.find((node) => node.id === id)?.ref).filter(Boolean));

    const legacyPrompt = buildSqlPrompt({
      question: caseDef.question,
      maxRows: 1000,
      schemaObjects: legacyObjects.map(toPromptObject),
      columns: legacyColumns,
      joinPolicies: schema.graph.edges
        .filter((edge) => legacyIds.has(edge.left_object_id) && legacyIds.has(edge.right_object_id))
        .map(toPromptJoin)
    });

    let hierarchicalPromptChars: number | null = null;
    if (expansion.status === "complete") {
      const selectedIds = new Set(expansion.object_ids);
      hierarchicalPromptChars = buildSqlPrompt({
        question: caseDef.question,
        maxRows: 1000,
        schemaObjects: schema.graph.nodes.filter((node) => selectedIds.has(node.id)).map(toPromptObject),
        columns: schema.columns.filter((column) => {
          const node = nodesByRef.get(`${column.schema_name}.${column.object_name}`);
          return Boolean(node && selectedIds.has(node.id));
        }),
        joinPolicies: expansion.edges.map(toPromptJoin)
      }).length;
    }

    const expectedPathPresentInLegacy = caseDef.expected_path_refs.every((ref) => {
      const node = nodesByRef.get(ref);
      return Boolean(node && legacyIds.has(node.id));
    });
    const hierarchicalPathCorrect = caseDef.expected_status === "ambiguous"
      ? expansion.status === "ambiguous"
      : expansion.status === "complete" && caseDef.expected_path_refs.every((ref) => expandedRefs.has(ref));

    results.push({
      id: caseDef.id,
      complexity: caseDef.complexity,
      expected_status: caseDef.expected_status,
      legacy_global: {
        table_recall_at_40: recall(caseDef.expected_core_refs, new Set(legacyObjects.map((node) => node.ref))),
        join_path_correct: caseDef.expected_status === "complete" && expectedPathPresentInLegacy,
        prompt_chars: legacyPrompt.length
      },
      hierarchical: {
        table_recall_at_15: recall(caseDef.expected_core_refs, candidateRefs),
        join_path_correct: hierarchicalPathCorrect,
        expansion_status: expansion.status,
        prompt_chars: hierarchicalPromptChars,
        latency_ms: round4(linkingLatency)
      }
    });
  }

  const legacyRecall = average(results.map((result) => result.legacy_global.table_recall_at_40));
  const hierarchicalRecall = average(results.map((result) => result.hierarchical.table_recall_at_15));
  const legacyJoinAccuracy = ratio(results.filter((result) => result.legacy_global.join_path_correct).length, results.length);
  const hierarchicalJoinAccuracy = ratio(results.filter((result) => result.hierarchical.join_path_correct).length, results.length);
  const legacyPromptChars = average(results.map((result) => result.legacy_global.prompt_chars));
  const hierarchicalPromptValues = results
    .map((result) => result.hierarchical.prompt_chars)
    .filter((value): value is number => Number.isFinite(value));
  const hierarchicalPromptChars = average(hierarchicalPromptValues);
  const scaling = buildScalingProfile(fixture);
  const minimumScaleRecall = Math.min(...scaling.map((item) => item.table_recall_at_15));
  const minimumScaleJoinAccuracy = Math.min(...scaling.map((item) => item.join_path_accuracy));
  const maximumScaleCandidateCount = Math.max(...scaling.map((item) => item.max_candidate_count));
  const maximumScaleLatency = Math.max(...scaling.map((item) => item.p95_linking_latency_ms));
  const gates = {
    table_recall_at_15_ge_95pct: hierarchicalRecall >= LARGE_SCHEMA_THRESHOLDS.table_recall_at_15,
    join_path_accuracy_eq_100pct: hierarchicalJoinAccuracy === LARGE_SCHEMA_THRESHOLDS.join_path_accuracy,
    improves_table_recall_over_legacy: hierarchicalRecall > legacyRecall,
    prompt_chars_below_legacy: hierarchicalPromptChars < legacyPromptChars,
    scale_recall_ge_95pct: minimumScaleRecall >= LARGE_SCHEMA_THRESHOLDS.table_recall_at_15,
    scale_join_accuracy_eq_100pct: minimumScaleJoinAccuracy === LARGE_SCHEMA_THRESHOLDS.join_path_accuracy,
    scale_candidate_count_bounded: maximumScaleCandidateCount <= fixture.candidate_limit,
    scale_p95_linking_latency_le_250ms: maximumScaleLatency <= LARGE_SCHEMA_THRESHOLDS.max_p95_linking_latency_ms
  };
  const gateDiagnostics: LargeSchemaGateDiagnostic[] = [
    {
      id: "table_recall_at_15_ge_95pct",
      stage: "schema_linking",
      metric: "table_recall_at_15",
      actual: round4(hierarchicalRecall),
      comparator: ">=",
      target: LARGE_SCHEMA_THRESHOLDS.table_recall_at_15,
      passed: gates.table_recall_at_15_ge_95pct
    },
    {
      id: "join_path_accuracy_eq_100pct",
      stage: "schema_linking",
      metric: "join_path_accuracy",
      actual: round4(hierarchicalJoinAccuracy),
      comparator: "=",
      target: LARGE_SCHEMA_THRESHOLDS.join_path_accuracy,
      passed: gates.join_path_accuracy_eq_100pct
    },
    {
      id: "improves_table_recall_over_legacy",
      stage: "schema_linking",
      metric: "table_recall_at_15",
      actual: round4(hierarchicalRecall),
      comparator: ">",
      target: round4(legacyRecall),
      passed: gates.improves_table_recall_over_legacy
    },
    {
      id: "prompt_chars_below_legacy",
      stage: "prompt_construction",
      metric: "average_prompt_chars",
      actual: Math.round(hierarchicalPromptChars),
      comparator: "<",
      target: Math.round(legacyPromptChars),
      passed: gates.prompt_chars_below_legacy
    },
    {
      id: "scale_recall_ge_95pct",
      stage: "schema_linking",
      metric: "minimum_scaled_table_recall_at_15",
      actual: round4(minimumScaleRecall),
      comparator: ">=",
      target: LARGE_SCHEMA_THRESHOLDS.table_recall_at_15,
      passed: gates.scale_recall_ge_95pct
    },
    {
      id: "scale_join_accuracy_eq_100pct",
      stage: "schema_linking",
      metric: "minimum_scaled_join_path_accuracy",
      actual: round4(minimumScaleJoinAccuracy),
      comparator: "=",
      target: LARGE_SCHEMA_THRESHOLDS.join_path_accuracy,
      passed: gates.scale_join_accuracy_eq_100pct
    },
    {
      id: "scale_candidate_count_bounded",
      stage: "schema_linking",
      metric: "maximum_scaled_candidate_count",
      actual: maximumScaleCandidateCount,
      comparator: "<=",
      target: fixture.candidate_limit,
      passed: gates.scale_candidate_count_bounded
    },
    {
      id: "scale_p95_linking_latency_le_250ms",
      stage: "schema_linking",
      metric: "maximum_scaled_p95_linking_latency_ms",
      actual: round4(maximumScaleLatency),
      comparator: "<=",
      target: LARGE_SCHEMA_THRESHOLDS.max_p95_linking_latency_ms,
      passed: gates.scale_p95_linking_latency_le_250ms
    }
  ];

  return {
    version: fixture.version,
    schema: {
      table_count: schema.graph.nodes.length,
      column_count: schema.columns.length,
      distractor_table_count: fixture.distractor_table_count
    },
    legacy_global: {
      table_recall_at_40: round4(legacyRecall),
      join_path_accuracy: round4(legacyJoinAccuracy),
      average_prompt_chars: Math.round(legacyPromptChars)
    },
    hierarchical: {
      table_recall_at_15: round4(hierarchicalRecall),
      join_path_accuracy: round4(hierarchicalJoinAccuracy),
      average_prompt_chars: Math.round(hierarchicalPromptChars),
      p95_linking_latency_ms: round4(percentile(results.map((result) => result.hierarchical.latency_ms), 0.95))
    },
    deltas: {
      table_recall: round4(hierarchicalRecall - legacyRecall),
      join_path_accuracy: round4(hierarchicalJoinAccuracy - legacyJoinAccuracy),
      average_prompt_chars: Math.round(hierarchicalPromptChars - legacyPromptChars)
    },
    release_gates: {
      ...gates,
      all_passed: Object.values(gates).every(Boolean)
    },
    gate_diagnostics: gateDiagnostics,
    scaling,
    cases: results
  };
}

function buildScalingProfile(fixture: LargeSchemaFixtureDefinition): LargeSchemaScaleResult[] {
  return LARGE_SCHEMA_SCALE_DISTRACTOR_COUNTS.map((distractorTableCount) => {
    const scaledFixture = { ...fixture, distractor_table_count: distractorTableCount };
    const schema = buildSyntheticSchema(scaledFixture);
    const cardsByRef = new Map(schema.cards.map((card) => [tableRef(card), card]));
    const caseMetrics = fixture.cases.map((caseDef) => {
      const expectedCoreIds = caseDef.expected_core_refs.map((ref) => required(cardsByRef, ref).id);
      const startedAt = performance.now();
      const candidates = rankTableCards(caseDef.question, schema.cards, [], fixture.candidate_limit);
      const expansion = expandSchemaGraph(schema.graph, expectedCoreIds, {
        maxIntermediateHops: caseDef.complexity === "multi_hop" ? 3 : 2,
        maxAlternativePaths: 4
      });
      const latencyMs = performance.now() - startedAt;
      const candidateRefs = new Set(candidates.map(tableRef));
      const expandedRefs = new Set(
        expansion.object_ids
          .map((id) => schema.graph.nodes.find((node) => node.id === id)?.ref)
          .filter((ref): ref is string => Boolean(ref))
      );
      const joinPathCorrect = caseDef.expected_status === "ambiguous"
        ? expansion.status === "ambiguous"
        : expansion.status === "complete" && caseDef.expected_path_refs.every((ref) => expandedRefs.has(ref));
      return {
        recall: recall(caseDef.expected_core_refs, candidateRefs),
        joinPathCorrect,
        candidateCount: candidates.length,
        latencyMs
      };
    });

    return {
      distractor_table_count: distractorTableCount,
      table_count: schema.graph.nodes.length,
      column_count: schema.columns.length,
      table_recall_at_15: round4(average(caseMetrics.map((item) => item.recall))),
      join_path_accuracy: round4(ratio(caseMetrics.filter((item) => item.joinPathCorrect).length, caseMetrics.length)),
      max_candidate_count: Math.max(...caseMetrics.map((item) => item.candidateCount)),
      p95_linking_latency_ms: round4(percentile(caseMetrics.map((item) => item.latencyMs), 0.95))
    };
  });
}

export function formatLargeSchemaGateFailures(result: LargeSchemaBenchmarkResult): string[] {
  return result.gate_diagnostics
    .filter((gate) => !gate.passed)
    .map((gate) => (
      `${gate.stage}.${gate.metric} failed: actual ${gate.actual} must be ${gate.comparator} ${gate.target}`
    ));
}

async function readFixture(filePath: string): Promise<LargeSchemaFixtureDefinition> {
  const parsed = JSON.parse(await fs.readFile(filePath, "utf8")) as LargeSchemaFixtureDefinition;
  if (!parsed || !Array.isArray(parsed.cases) || parsed.cases.length === 0) {
    throw new Error("Large-schema benchmark fixture must include cases");
  }
  return parsed;
}

function buildSyntheticSchema(fixture: LargeSchemaFixtureDefinition): SyntheticSchema {
  const cards: TableCard[] = [];
  const nodes: SchemaGraphNode[] = [];
  const edges: SchemaGraphEdge[] = [];
  const columns: SyntheticSchema["columns"] = [];

  const addTable = (
    schemaName: string,
    objectName: string,
    aliases: string[],
    synonyms: string[],
    columnNames: string[]
  ): TableCard => {
    const id = `${schemaName}.${objectName}`;
    const card: TableCard = {
      id,
      schema_name: schemaName,
      object_name: objectName,
      object_type: "table",
      description: `${aliases.join(" ")} reporting table`,
      primary_keys: [`${objectName}_id`],
      join_columns: [],
      relationships: [],
      approved_join_refs: [],
      semantic_aliases: aliases,
      synonyms: synonyms.map((term) => ({ term, weight: 2 }))
    };
    cards.push(card);
    nodes.push({ id, schema_name: schemaName, object_name: objectName, object_type: "table", ref: id });
    for (const columnName of columnNames) {
      columns.push({ schema_name: schemaName, object_name: objectName, column_name: columnName, data_type: "text" });
    }
    return card;
  };

  const payment = addTable("public", "payment", ["Revenue", "Sales"], ["money collected"], ["payment_id", "customer_id", "rental_id", "amount", "payment_date"]);
  const customer = addTable("public", "customer", ["Customer"], ["buyer"], ["customer_id", "first_name", "last_name"]);
  const rental = addTable("public", "rental", ["Rental"], [], ["rental_id", "inventory_id"]);
  const inventory = addTable("public", "inventory", ["Inventory"], [], ["inventory_id", "film_id"]);
  const filmCategory = addTable("public", "film_category", ["Film category bridge"], [], ["film_id", "category_id"]);
  const category = addTable("public", "category", ["Film category"], ["genre"], ["category_id", "name"]);
  addTable(
    "analytics",
    "customer_activity_wide",
    ["Customer activity profile"],
    ["risk segment"],
    Array.from({ length: 250 }, (_, index) => index === 249 ? "risk_segment" : `attribute_${index}`)
  );
  const ambiguousOrders = addTable("public", "ambiguous_orders", ["Ambiguous orders"], [], ["order_id", "customer_id", "account_id"]);
  const customerBridge = addTable("public", "customer_bridge", ["Customer bridge"], [], ["order_id", "customer_id"]);
  const accountBridge = addTable("public", "account_bridge", ["Account bridge"], [], ["order_id", "customer_id"]);
  const ambiguousCustomer = addTable("public", "ambiguous_customer", ["Ambiguous customer"], [], ["customer_id"]);

  const addEdge = (id: string, left: TableCard, right: TableCard, leftColumn: string, rightColumn: string): void => {
    const edge: SchemaGraphEdge = {
      id,
      left_object_id: left.id,
      right_object_id: right.id,
      left_ref: tableRef(left),
      right_ref: tableRef(right),
      source: "relationship",
      join_type: "INNER",
      on_clause: `${tableRef(left)}.${leftColumn} = ${tableRef(right)}.${rightColumn}`,
      relationship_type: "fk"
    };
    edges.push(edge);
    left.join_columns.push(leftColumn);
    right.join_columns.push(rightColumn);
    left.relationships.push({ column: leftColumn, related_ref: tableRef(right), related_column: rightColumn, direction: "outbound", relationship_type: "fk" });
    right.relationships.push({ column: rightColumn, related_ref: tableRef(left), related_column: leftColumn, direction: "inbound", relationship_type: "fk" });
  };

  addEdge("payment-customer", payment, customer, "customer_id", "customer_id");
  addEdge("payment-rental", payment, rental, "rental_id", "rental_id");
  addEdge("rental-inventory", rental, inventory, "inventory_id", "inventory_id");
  addEdge("inventory-film-category", inventory, filmCategory, "film_id", "film_id");
  addEdge("film-category-category", filmCategory, category, "category_id", "category_id");
  addEdge("orders-customer-bridge", ambiguousOrders, customerBridge, "order_id", "order_id");
  addEdge("customer-bridge-customer", customerBridge, ambiguousCustomer, "customer_id", "customer_id");
  addEdge("orders-account-bridge", ambiguousOrders, accountBridge, "order_id", "order_id");
  addEdge("account-bridge-customer", accountBridge, ambiguousCustomer, "customer_id", "customer_id");

  for (let index = 0; index < fixture.distractor_table_count; index += 1) {
    const kind = index % 3 === 0 ? "payment" : index % 3 === 1 ? "customer" : "category";
    addTable(
      `archive_${String(index).padStart(3, "0")}`,
      `${kind}_snapshot_${String(index).padStart(3, "0")}`,
      [`Historical ${kind} archive`],
      [],
      Array.from({ length: fixture.distractor_columns_per_table }, (_, columnIndex) => `field_${columnIndex}`)
    );
  }

  return { cards, graph: { nodes, edges }, columns };
}

function tableRef(card: Pick<TableCard, "schema_name" | "object_name">): string {
  return `${card.schema_name}.${card.object_name}`;
}

function toPromptObject(node: SchemaGraphNode) {
  return { schema_name: node.schema_name, object_name: node.object_name, object_type: node.object_type };
}

function toPromptJoin(edge: SchemaGraphEdge) {
  return { left_ref: edge.left_ref, right_ref: edge.right_ref, join_type: edge.join_type, on_clause: edge.on_clause };
}

function compareColumns(a: SyntheticSchema["columns"][number], b: SyntheticSchema["columns"][number]): number {
  return `${a.schema_name}.${a.object_name}.${a.column_name}`.localeCompare(`${b.schema_name}.${b.object_name}.${b.column_name}`);
}

function recall(expected: string[], actual: Set<string>): number {
  return ratio(expected.filter((ref) => actual.has(ref)).length, expected.length);
}

function required<T>(map: Map<string, T>, key: string): T {
  const value = map.get(key);
  if (!value) {
    throw new Error(`Large-schema fixture references unknown table ${key}`);
  }
  return value;
}

function average(values: number[]): number {
  return values.length > 0 ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
}

function ratio(numerator: number, denominator: number): number {
  return denominator > 0 ? numerator / denominator : 0;
}

function percentile(values: number[], p: number): number {
  if (values.length === 0) {
    return 0;
  }
  const sorted = values.slice().sort((a, b) => a - b);
  const index = Math.max(0, Math.min(sorted.length - 1, Math.ceil(sorted.length * p) - 1));
  return sorted[index];
}

function round4(value: number): number {
  return Number(value.toFixed(4));
}
