import { createHash } from "crypto";
import type { SchemaExpansion, SchemaGraphEdge, SchemaPath } from "./schemaGraphService";
import type { TableCandidate } from "./schemaLinkingService";

export interface QueryClarificationOption {
  id: string;
  label: string;
  description: string;
  table_refs: string[];
}

export interface QueryClarification {
  kind: "join_path" | "table" | "metric";
  message: string;
  options: QueryClarificationOption[];
}

export interface CandidateClarification {
  clarification: QueryClarification;
  candidate_ids: string[];
}

export function buildCandidateClarification(
  question: string,
  candidates: TableCandidate[]
): CandidateClarification | null {
  return buildMetricClarification(question, candidates)
    || buildTableClarification(question, candidates);
}

export function findCandidateIdByOptionId(
  ambiguity: CandidateClarification,
  optionId: string
): string | null {
  const index = ambiguity.clarification.options.findIndex((option) => option.id === optionId);
  return index >= 0 ? ambiguity.candidate_ids[index] : null;
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

export function findJoinPathByOptionId(
  expansion: SchemaExpansion,
  optionId: string
): SchemaPath | null {
  const normalized = String(optionId || "").trim();
  if (!normalized) return null;
  for (const ambiguity of expansion.ambiguities) {
    for (const path of ambiguity.alternatives) {
      if (optionIdForPath(path) === normalized) return path;
    }
  }
  return null;
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
    id: optionIdForPath(path),
    label,
    description: `Uses ${path.edges.length} ${path.edges.length === 1 ? "relationship" : "relationships"} across ${tableRefs.join(", ")}.`,
    table_refs: tableRefs
  };
}

function optionIdForPath(path: SchemaPath): string {
  return `join_path_${createHash("sha256").update(pathSignature(path)).digest("hex").slice(0, 12)}`;
}

function buildMetricClarification(question: string, candidates: TableCandidate[]): CandidateClarification | null {
  const normalizedQuestion = normalizePhrase(question);
  const aliases = new Map<string, { label: string; candidates: TableCandidate[] }>();
  for (const candidate of candidates) {
    for (const alias of candidate.semantic_aliases) {
      const normalizedAlias = normalizePhrase(alias);
      if (!normalizedAlias || !phraseMatches(normalizedQuestion, normalizedAlias)) continue;
      const group = aliases.get(normalizedAlias) || { label: alias, candidates: [] };
      group.candidates.push(candidate);
      aliases.set(normalizedAlias, group);
    }
  }

  const competing = [...aliases.entries()]
    .filter(([, group]) => uniqueCandidates(group.candidates).length > 1)
    .filter(([, group]) => !group.candidates.some((candidate) => questionNamesCandidate(normalizedQuestion, candidate)))
    .sort(([left], [right]) => right.length - left.length || left.localeCompare(right))[0]?.[1];
  if (!competing) return null;
  const options = uniqueCandidates(competing.candidates).sort(compareCandidateRefs);
  return candidateClarification(
    "metric",
    `“${competing.label}” maps to multiple reporting entities. Choose the intended source.`,
    options,
    (candidate) => `Use ${competing.label} from ${candidate.schema_name}.${candidate.object_name}`
  );
}

function buildTableClarification(question: string, candidates: TableCandidate[]): CandidateClarification | null {
  const normalizedQuestion = normalizePhrase(question);
  const groups = new Map<string, TableCandidate[]>();
  for (const candidate of candidates) {
    const objectName = normalizePhrase(candidate.object_name.replace(/_/g, " "));
    if (!objectName || !phraseMatches(normalizedQuestion, objectName)) continue;
    if (phraseMatches(normalizedQuestion, normalizePhrase(`${candidate.schema_name} ${candidate.object_name}`.replace(/_/g, " ")))) {
      continue;
    }
    const group = groups.get(candidate.object_name.toLowerCase()) || [];
    group.push(candidate);
    groups.set(candidate.object_name.toLowerCase(), group);
  }

  const competing = [...groups.values()]
    .filter((group) => uniqueCandidates(group).length > 1)
    .sort((left, right) => compareCandidateRefs(left[0], right[0]))[0];
  if (!competing) return null;
  const options = uniqueCandidates(competing).sort(compareCandidateRefs);
  return candidateClarification(
    "table",
    `“${options[0].object_name}” exists in multiple schemas. Choose the intended table.`,
    options,
    (candidate) => `Use ${candidate.schema_name}.${candidate.object_name}`
  );
}

function candidateClarification(
  kind: "table" | "metric",
  message: string,
  candidates: TableCandidate[],
  label: (candidate: TableCandidate) => string
): CandidateClarification {
  return {
    clarification: {
      kind,
      message,
      options: candidates.slice(0, 8).map((candidate) => ({
        id: `${kind}_${createHash("sha256").update(candidate.id).digest("hex").slice(0, 12)}`,
        label: label(candidate),
        description: `Uses the reporting object ${candidate.schema_name}.${candidate.object_name}.`,
        table_refs: [`${candidate.schema_name}.${candidate.object_name}`]
      }))
    },
    candidate_ids: candidates.slice(0, 8).map((candidate) => candidate.id)
  };
}

function questionNamesCandidate(question: string, candidate: TableCandidate): boolean {
  return phraseMatches(question, normalizePhrase(candidate.object_name.replace(/_/g, " ")))
    || phraseMatches(question, normalizePhrase(`${candidate.schema_name} ${candidate.object_name}`.replace(/_/g, " ")));
}

function uniqueCandidates(candidates: TableCandidate[]): TableCandidate[] {
  const seen = new Set<string>();
  return candidates.filter((candidate) => {
    if (seen.has(candidate.id)) return false;
    seen.add(candidate.id);
    return true;
  });
}

function compareCandidateRefs(left: TableCandidate, right: TableCandidate): number {
  return left.schema_name.localeCompare(right.schema_name)
    || left.object_name.localeCompare(right.object_name)
    || left.id.localeCompare(right.id);
}

function normalizePhrase(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function phraseMatches(question: string, phrase: string): boolean {
  return Boolean(phrase) && ` ${question} `.includes(` ${phrase} `);
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
