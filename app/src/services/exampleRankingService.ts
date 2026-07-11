import type { RagRetrievalDoc } from "./ragRetrieval";

export interface RankValidatedExamplesOptions {
  selectedSchemaRefs: Iterable<string>;
  maxExamples?: number;
  maxChars?: number;
  minManualQuality?: number;
  minFeedbackQuality?: number;
}

interface RankedExample {
  document: RagRetrievalDoc;
  score: number;
  quality: number;
  source: string;
}

const DEFAULT_MAX_EXAMPLES = 4;
const DEFAULT_MAX_CHARS = 6_000;
const DEFAULT_MIN_MANUAL_QUALITY = 0.5;
const DEFAULT_MIN_FEEDBACK_QUALITY = 0.8;

export function rankValidatedExamples(
  documents: RagRetrievalDoc[],
  options: RankValidatedExamplesOptions
): RagRetrievalDoc[] {
  const selectedRefs = new Set(
    [...options.selectedSchemaRefs].map(normalizeRef).filter(Boolean)
  );
  const maxExamples = positiveInteger(options.maxExamples, DEFAULT_MAX_EXAMPLES);
  const maxChars = positiveInteger(options.maxChars, DEFAULT_MAX_CHARS);
  const minManualQuality = boundedScore(options.minManualQuality, DEFAULT_MIN_MANUAL_QUALITY);
  const minFeedbackQuality = boundedScore(options.minFeedbackQuality, DEFAULT_MIN_FEEDBACK_QUALITY);

  const candidates = documents
    .filter((document) => document.doc_type === "example")
    .map((document) => toRankedExample(document, selectedRefs))
    .filter((candidate): candidate is RankedExample => candidate !== null)
    .filter((candidate) => candidate.quality >= (
      candidate.source === "feedback" ? minFeedbackQuality : minManualQuality
    ))
    .sort(compareExamples);

  const selected: RankedExample[] = [];
  let usedChars = 0;
  for (const candidate of candidates) {
    if (selected.length >= maxExamples) break;
    if (usedChars + candidate.document.content.length > maxChars) continue;
    if (selected.some((existing) => nearDuplicate(existing.document, candidate.document))) continue;

    selected.push(candidate);
    usedChars += candidate.document.content.length;
  }

  return selected.map(({ document, score }) => ({
    ...document,
    rerank_score: score
  }));
}

function toRankedExample(document: RagRetrievalDoc, selectedRefs: Set<string>): RankedExample | null {
  const metadata = document.metadata_json;
  if (!metadata || metadata.validation_state !== "validated") return null;

  const schemaRefs = Array.isArray(metadata.schema_refs)
    ? metadata.schema_refs.map(normalizeRef).filter(Boolean)
    : [];
  if (schemaRefs.length === 0 || schemaRefs.some((ref) => !selectedRefs.has(ref))) return null;

  if (metadata.source !== "manual" && metadata.source !== "feedback") return null;
  const source = metadata.source;
  const quality = boundedScore(metadata.quality_score, source === "manual" ? 0.75 : 0);
  const relevance = finiteNumber(document.rerank_score, finiteNumber(document.score, 0));
  const sourceBoost = source === "manual" ? 0.5 : 0;
  const score = Number((relevance + (quality * 2) + sourceBoost).toFixed(4));
  return { document, score, quality, source };
}

function compareExamples(left: RankedExample, right: RankedExample): number {
  return right.score - left.score
    || right.quality - left.quality
    || left.source.localeCompare(right.source)
    || left.document.id.localeCompare(right.document.id);
}

function nearDuplicate(left: RagRetrievalDoc, right: RagRetrievalDoc): boolean {
  const leftSql = normalizedSql(left.content);
  const rightSql = normalizedSql(right.content);
  if (leftSql && leftSql === rightSql) return true;

  const leftTokens = tokenSet(left.content);
  const rightTokens = tokenSet(right.content);
  if (leftTokens.size === 0 || rightTokens.size === 0) return false;
  const intersection = [...leftTokens].filter((token) => rightTokens.has(token)).length;
  const union = new Set([...leftTokens, ...rightTokens]).size;
  return intersection / union >= 0.92;
}

function normalizedSql(content: string): string {
  const marker = "example sql ";
  const start = content.toLowerCase().indexOf(marker);
  if (start < 0) return "";
  return content.slice(start + marker.length).toLowerCase().replace(/\s+/g, " ").trim();
}

function tokenSet(value: string): Set<string> {
  return new Set(value.toLowerCase().match(/[a-z0-9_]+/g) || []);
}

function normalizeRef(value: unknown): string {
  return String(value || "").trim().toLowerCase();
}

function positiveInteger(value: unknown, fallback: number): number {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : fallback;
}

function boundedScore(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.min(1, Math.max(0, value))
    : fallback;
}

function finiteNumber(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}
