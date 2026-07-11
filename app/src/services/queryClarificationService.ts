import { createHash } from "crypto";
import type { SchemaExpansion, SchemaGraphEdge, SchemaPath } from "./schemaGraphService";

export interface QueryClarificationOption {
  id: string;
  label: string;
  description: string;
  table_refs: string[];
}

export interface QueryClarification {
  kind: "join_path";
  message: string;
  options: QueryClarificationOption[];
}

export function buildJoinPathClarification(expansion: SchemaExpansion): QueryClarification | null {
  if (expansion.status !== "ambiguous") return null;

  const paths = expansion.ambiguities
    .flatMap((ambiguity) => ambiguity.alternatives)
    .sort((left, right) => pathSignature(left).localeCompare(pathSignature(right)));
  const unique = uniquePaths(paths).slice(0, 8);
  const options = unique.map((path, index) => toOption(path, index, unique.length));
  if (options.length < 2) return null;

  return {
    kind: "join_path",
    message: "Multiple valid join paths were found. Choose the relationship that matches your reporting intent.",
    options
  };
}

function toOption(path: SchemaPath, index: number, total: number): QueryClarificationOption {
  const tableRefs = path.object_ids
    .map((objectId) => refForObject(path.edges, objectId))
    .filter((ref): ref is string => Boolean(ref));
  const connectors = tableRefs.slice(1, -1);
  const sourceLabel = path.edges.every((edge) => edge.source === "approved_policy")
    ? "approved join policy"
    : "schema relationship";
  const baseLabel = connectors.length > 0
    ? `Join through ${connectors.join(" → ")}`
    : `Use ${sourceLabel}`;
  const label = total > 1 && duplicateLabelRisk(path)
    ? `${baseLabel} (option ${index + 1})`
    : baseLabel;

  return {
    id: `join_path_${createHash("sha256").update(pathSignature(path)).digest("hex").slice(0, 12)}`,
    label,
    description: `Uses ${path.edges.length} ${path.edges.length === 1 ? "relationship" : "relationships"} across ${tableRefs.join(", ")}.`,
    table_refs: tableRefs
  };
}

function duplicateLabelRisk(path: SchemaPath): boolean {
  return path.object_ids.length <= 2;
}

function refForObject(edges: SchemaGraphEdge[], objectId: string): string | null {
  for (const edge of edges) {
    if (edge.left_object_id === objectId) return edge.left_ref;
    if (edge.right_object_id === objectId) return edge.right_ref;
  }
  return null;
}

function uniquePaths(paths: SchemaPath[]): SchemaPath[] {
  const seen = new Set<string>();
  return paths.filter((path) => {
    const signature = pathSignature(path);
    if (seen.has(signature)) return false;
    seen.add(signature);
    return true;
  });
}

function pathSignature(path: SchemaPath): string {
  return `${path.object_ids.join(">")}|${path.edge_ids.join(">")}`;
}
