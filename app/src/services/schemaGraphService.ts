import appDb = require("../lib/appDb");
import { loadScopedQueryContext, type QueryContext } from "./queryOrchestrationStore";

export interface SchemaGraphNode {
  id: string;
  schema_name: string;
  object_name: string;
  object_type: string;
  ref: string;
}

export interface SchemaGraphEdge {
  id: string;
  left_object_id: string;
  right_object_id: string;
  left_ref: string;
  right_ref: string;
  source: "approved_policy" | "relationship";
  join_type: string;
  on_clause: string;
  relationship_type: string | null;
}

export interface SchemaGraph {
  nodes: SchemaGraphNode[];
  edges: SchemaGraphEdge[];
}

export interface SchemaPath {
  object_ids: string[];
  edge_ids: string[];
  edges: SchemaGraphEdge[];
  approved_policy_count: number;
}

export interface SchemaPathAmbiguity {
  target_object_id: string;
  alternatives: SchemaPath[];
}

export interface SchemaExpansion {
  status: "complete" | "ambiguous" | "disconnected";
  core_object_ids: string[];
  object_ids: string[];
  connector_object_ids: string[];
  edges: SchemaGraphEdge[];
  paths: SchemaPath[];
  ambiguities: SchemaPathAmbiguity[];
  unresolved_object_ids: string[];
}

export interface ExpandSchemaOptions {
  maxIntermediateHops?: number;
  maxAlternativePaths?: number;
}

export interface ExpandedSchemaContext {
  graph: SchemaGraph;
  expansion: SchemaExpansion;
  context: QueryContext | null;
}

interface SchemaObjectRow {
  id: string;
  schema_name: string;
  object_name: string;
  object_type: string;
}

interface RelationshipRow {
  id: string;
  from_object_id: string;
  from_column: string;
  from_schema: string;
  from_object: string;
  to_object_id: string;
  to_column: string;
  to_schema: string;
  to_object: string;
  relationship_type: string;
}

interface JoinPolicyRow {
  id: string;
  left_ref: string;
  right_ref: string;
  join_type: string;
  on_clause: string;
}

export async function loadSchemaGraph(dataSourceId: string): Promise<SchemaGraph> {
  const [objectsResult, relationshipsResult, policiesResult] = await Promise.all([
    appDb.query<SchemaObjectRow>(
      `
        SELECT id, schema_name, object_name, object_type
        FROM schema_objects
        WHERE data_source_id = $1
          AND is_ignored = FALSE
          AND object_type IN ('table', 'view', 'materialized_view')
        ORDER BY schema_name, object_name
      `,
      [dataSourceId]
    ),
    appDb.query<RelationshipRow>(
      `
        SELECT
          r.id,
          r.from_object_id,
          r.from_column,
          source.schema_name AS from_schema,
          source.object_name AS from_object,
          r.to_object_id,
          r.to_column,
          target.schema_name AS to_schema,
          target.object_name AS to_object,
          r.relationship_type
        FROM relationships r
        JOIN schema_objects source ON source.id = r.from_object_id
        JOIN schema_objects target ON target.id = r.to_object_id
        WHERE source.data_source_id = $1
          AND target.data_source_id = $1
          AND source.is_ignored = FALSE
          AND target.is_ignored = FALSE
        ORDER BY r.id
      `,
      [dataSourceId]
    ),
    appDb.query<JoinPolicyRow>(
      `
        SELECT id, left_ref, right_ref, join_type, on_clause
        FROM join_policies
        WHERE data_source_id = $1 AND approved = TRUE
        ORDER BY left_ref, right_ref, id
      `,
      [dataSourceId]
    )
  ]);

  const nodes = objectsResult.rows.map<SchemaGraphNode>((object) => ({
    ...object,
    ref: `${object.schema_name}.${object.object_name}`
  }));
  const resolveNode = buildNodeResolver(nodes);
  const edges: SchemaGraphEdge[] = relationshipsResult.rows.map((relationship) => ({
    id: `relationship:${relationship.id}`,
    left_object_id: relationship.from_object_id,
    right_object_id: relationship.to_object_id,
    left_ref: `${relationship.from_schema}.${relationship.from_object}`,
    right_ref: `${relationship.to_schema}.${relationship.to_object}`,
    source: "relationship",
    join_type: "INNER",
    on_clause: `${relationship.from_schema}.${relationship.from_object}.${relationship.from_column} = ${relationship.to_schema}.${relationship.to_object}.${relationship.to_column}`,
    relationship_type: relationship.relationship_type
  }));

  for (const policy of policiesResult.rows) {
    const left = resolveNode(policy.left_ref);
    const right = resolveNode(policy.right_ref);
    if (!left || !right || left.id === right.id) {
      continue;
    }
    edges.push({
      id: `policy:${policy.id}`,
      left_object_id: left.id,
      right_object_id: right.id,
      left_ref: left.ref,
      right_ref: right.ref,
      source: "approved_policy",
      join_type: policy.join_type,
      on_clause: policy.on_clause,
      relationship_type: null
    });
  }

  return {
    nodes,
    edges: edges.sort(compareEdges)
  };
}

export function expandSchemaGraph(
  graph: SchemaGraph,
  coreObjectIds: string[],
  opts: ExpandSchemaOptions = {}
): SchemaExpansion {
  const coreIds = unique(coreObjectIds.map((id) => String(id).trim()).filter(Boolean));
  const nodeIds = new Set(graph.nodes.map((node) => node.id));
  const unresolved = coreIds.filter((id) => !nodeIds.has(id));
  const knownCoreIds = coreIds.filter((id) => nodeIds.has(id));
  const maxIntermediateHops = nonNegativeInteger(opts.maxIntermediateHops, 2);
  const maxAlternativePaths = positiveInteger(opts.maxAlternativePaths, 4);
  const adjacency = buildAdjacency(graph);
  const connected = new Set<string>();
  const selectedEdges = new Map<string, SchemaGraphEdge>();
  const paths: SchemaPath[] = [];
  const ambiguities: SchemaPathAmbiguity[] = [];

  if (knownCoreIds.length > 0) {
    connected.add(knownCoreIds[0]);
  }

  for (const targetId of knownCoreIds.slice(1)) {
    if (connected.has(targetId)) {
      continue;
    }
    const alternatives = findBestPaths(
      adjacency,
      connected,
      targetId,
      maxIntermediateHops + 1,
      maxAlternativePaths
    );
    if (alternatives.length === 0) {
      unresolved.push(targetId);
      continue;
    }
    if (alternatives.length > 1) {
      ambiguities.push({ target_object_id: targetId, alternatives });
      continue;
    }

    const path = alternatives[0];
    paths.push(path);
    for (const objectId of path.object_ids) {
      connected.add(objectId);
    }
    for (const edge of path.edges) {
      selectedEdges.set(edge.id, edge);
    }
  }

  const selectedObjectIds = unique([...knownCoreIds.filter((id) => connected.has(id)), ...connected]);
  const coreSet = new Set(coreIds);
  return {
    status: ambiguities.length > 0 ? "ambiguous" : unresolved.length > 0 ? "disconnected" : "complete",
    core_object_ids: coreIds,
    object_ids: selectedObjectIds,
    connector_object_ids: selectedObjectIds.filter((id) => !coreSet.has(id)),
    edges: [...selectedEdges.values()].sort(compareEdges),
    paths,
    ambiguities,
    unresolved_object_ids: unique(unresolved)
  };
}

export async function loadExpandedSchemaContext(
  dataSourceId: string,
  coreObjectIds: string[],
  opts: ExpandSchemaOptions = {}
): Promise<ExpandedSchemaContext> {
  const graph = await loadSchemaGraph(dataSourceId);
  const expansion = expandSchemaGraph(graph, coreObjectIds, opts);
  let context: QueryContext | null = null;
  if (expansion.status === "complete") {
    const scopedContext = await loadScopedQueryContext(dataSourceId, expansion.object_ids);
    context = {
      ...scopedContext,
      joinPolicies: expansion.edges.map((edge) => ({
        id: edge.id,
        left_ref: edge.left_ref,
        right_ref: edge.right_ref,
        join_type: edge.join_type,
        on_clause: edge.on_clause
      }))
    };
  }
  return { graph, expansion, context };
}

function findBestPaths(
  adjacency: Map<string, SchemaGraphEdge[]>,
  sourceIds: Set<string>,
  targetId: string,
  maxEdges: number,
  maxAlternatives: number
): SchemaPath[] {
  interface SearchState {
    depth: number;
    approvedCount: number;
    paths: SchemaPath[];
  }

  const bestByNode = new Map<string, SearchState>();
  const queue: string[] = [];
  for (const sourceId of [...sourceIds].sort()) {
    bestByNode.set(sourceId, {
      depth: 0,
      approvedCount: 0,
      paths: [toSchemaPath([sourceId], [])]
    });
    queue.push(sourceId);
  }

  while (queue.length > 0) {
    const currentId = queue.shift()!;
    const current = bestByNode.get(currentId)!;
    if (currentId === targetId || current.depth >= maxEdges) {
      continue;
    }

    for (const path of current.paths) {
      for (const edge of adjacency.get(currentId) || []) {
        const nextId = otherObjectId(edge, currentId);
        if (path.object_ids.includes(nextId)) {
          continue;
        }
        const nextPath = toSchemaPath([...path.object_ids, nextId], [...path.edges, edge]);
        const nextDepth = current.depth + 1;
        const nextApproved = nextPath.approved_policy_count;
        const existing = bestByNode.get(nextId);
        const isBetter = !existing
          || nextDepth < existing.depth
          || (nextDepth === existing.depth && nextApproved > existing.approvedCount);
        const isEqual = existing
          && nextDepth === existing.depth
          && nextApproved === existing.approvedCount;

        if (isBetter) {
          bestByNode.set(nextId, {
            depth: nextDepth,
            approvedCount: nextApproved,
            paths: [nextPath]
          });
          if (!existing) {
            queue.push(nextId);
          }
        } else if (isEqual) {
          const signatures = new Set(existing.paths.map(pathSignature));
          if (!signatures.has(pathSignature(nextPath)) && existing.paths.length < maxAlternatives) {
            existing.paths.push(nextPath);
            existing.paths.sort((a, b) => pathSignature(a).localeCompare(pathSignature(b)));
          }
        }
      }
    }
  }

  const target = bestByNode.get(targetId);
  if (!target || target.depth === 0) {
    return [];
  }
  return target.paths
    .sort((a, b) => pathSignature(a).localeCompare(pathSignature(b)))
    .slice(0, maxAlternatives);
}

function buildAdjacency(graph: SchemaGraph): Map<string, SchemaGraphEdge[]> {
  const adjacency = new Map<string, SchemaGraphEdge[]>();
  for (const node of graph.nodes) {
    adjacency.set(node.id, []);
  }
  for (const edge of graph.edges) {
    if (!adjacency.has(edge.left_object_id) || !adjacency.has(edge.right_object_id)) {
      continue;
    }
    adjacency.get(edge.left_object_id)!.push(edge);
    adjacency.get(edge.right_object_id)!.push(edge);
  }
  for (const edges of adjacency.values()) {
    edges.sort(compareEdges);
  }
  return adjacency;
}

function buildNodeResolver(nodes: SchemaGraphNode[]): (ref: string) => SchemaGraphNode | undefined {
  const qualified = new Map(nodes.map((node) => [normalizeRef(node.ref), node]));
  const unqualified = new Map<string, SchemaGraphNode | null>();
  for (const node of nodes) {
    const key = normalizeRef(node.object_name);
    unqualified.set(key, unqualified.has(key) ? null : node);
  }

  return (ref: string) => {
    const normalized = normalizeRef(ref);
    const parts = normalized.split(".").filter(Boolean);
    for (let end = parts.length; end > 0; end -= 1) {
      const direct = qualified.get(parts.slice(0, end).join("."));
      if (direct) {
        return direct;
      }
    }
    return unqualified.get(parts[0] || normalized) || undefined;
  };
}

function toSchemaPath(objectIds: string[], edges: SchemaGraphEdge[]): SchemaPath {
  return {
    object_ids: objectIds,
    edge_ids: edges.map((edge) => edge.id),
    edges,
    approved_policy_count: edges.filter((edge) => edge.source === "approved_policy").length
  };
}

function otherObjectId(edge: SchemaGraphEdge, currentId: string): string {
  return edge.left_object_id === currentId ? edge.right_object_id : edge.left_object_id;
}

function pathSignature(path: SchemaPath): string {
  return `${path.object_ids.join(">")}|${path.edge_ids.join(">")}`;
}

function compareEdges(a: SchemaGraphEdge, b: SchemaGraphEdge): number {
  const sourceOrder = Number(b.source === "approved_policy") - Number(a.source === "approved_policy");
  return sourceOrder || a.id.localeCompare(b.id);
}

function normalizeRef(value: unknown): string {
  return String(value || "").trim().toLowerCase().replace(/["'`\[\]\s]/g, "");
}

function unique<T>(values: T[]): T[] {
  return [...new Set(values)];
}

function positiveInteger(value: unknown, fallback: number): number {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : fallback;
}

function nonNegativeInteger(value: unknown, fallback: number): number {
  const number = Number(value);
  return Number.isInteger(number) && number >= 0 ? number : fallback;
}
