import ragRetrieval = require("./ragRetrieval");
import {
  loadTableCards,
  rankTableCards,
  type TableCandidate,
  type TableCard
} from "./schemaLinkingService";
import { linkTablesWithRouting, type LinkTablesResult } from "./llmSchemaLinkerService";
import {
  loadExpandedSchemaContext,
  loadResolvedSchemaContext,
  type ExpandedSchemaContext,
  type SchemaExpansion,
  type SchemaPath
} from "./schemaGraphService";
import type { QueryContext } from "./queryOrchestrationStore";
import type { RagRetrievalDoc } from "./ragRetrieval";
import { rankValidatedExamples } from "./exampleRankingService";
import {
  buildJoinPathClarification,
  buildCandidateClarification,
  findCandidateIdByOptionId,
  findJoinPathByOptionId,
  type QueryClarification
} from "./queryClarificationService";
import { withTelemetrySpan } from "../lib/telemetry";

const { retrieveRagContext } = ragRetrieval;

export interface PrepareGenerationContextInput {
  dataSourceId: string;
  question: string;
  requestedProvider?: string | null;
  requestedModel?: string | null;
  requestId?: string | null;
  candidateLimit?: number;
  finalRagLimit?: number;
  clarificationOptionId?: string | null;
  resolvedClarificationOptionIds?: string[];
}

export interface SchemaLinkingDiagnostics {
  candidates: Array<{
    id: string;
    ref: string;
    score: number;
    lexical_score: number;
    rag_score: number;
    matched_terms: string[];
  }>;
  linker: LinkTablesResult | null;
  expansion: SchemaExpansion | null;
}

export type PrepareGenerationContextResult =
  | {
    ok: true;
    context: QueryContext;
    ragDocuments: RagRetrievalDoc[];
    diagnostics: SchemaLinkingDiagnostics;
  }
  | {
    ok: false;
    code: "no_schema_candidates" | "schema_linking_ambiguous" | "schema_linking_disconnected" | "clarification_option_invalid";
    message: string;
    clarification: QueryClarification | null;
    diagnostics: SchemaLinkingDiagnostics;
  };

export interface GenerationContextDependencies {
  loadTableCards: (dataSourceId: string) => Promise<TableCard[]>;
  retrieveRagContext: typeof retrieveRagContext;
  linkTablesWithRouting: typeof linkTablesWithRouting;
  loadExpandedSchemaContext: typeof loadExpandedSchemaContext;
  loadResolvedSchemaContext: typeof loadResolvedSchemaContext;
}

const defaultDependencies: GenerationContextDependencies = {
  loadTableCards,
  retrieveRagContext,
  linkTablesWithRouting,
  loadExpandedSchemaContext,
  loadResolvedSchemaContext
};

export async function prepareQueryGenerationContext(
  input: PrepareGenerationContextInput,
  dependencies: GenerationContextDependencies = defaultDependencies
): Promise<PrepareGenerationContextResult> {
  const candidateLimit = positiveInteger(input.candidateLimit, 15);
  const finalRagLimit = positiveInteger(input.finalRagLimit, 12);
  const retrievalLimit = Math.max(candidateLimit * 3, finalRagLimit);
  const [cards, retrievedDocuments] = await Promise.all([
    withTelemetrySpan("query.schema.retrieve", {
      "pipeline.stage": "schema_retrieval"
    }, () => dependencies.loadTableCards(input.dataSourceId)),
    withTelemetrySpan("query.rag.retrieve", {
      "pipeline.stage": "rag_retrieval"
    }, () => dependencies.retrieveRagContext(input.dataSourceId, input.question, { limit: retrievalLimit }))
  ]);
  const candidates = rankTableCards(input.question, cards, retrievedDocuments, candidateLimit);
  const diagnostics: SchemaLinkingDiagnostics = {
    candidates: summarizeCandidates(candidates),
    linker: null,
    expansion: null
  };

  if (candidates.length === 0) {
    return {
      ok: false,
      code: "no_schema_candidates",
      message: "No relevant schema objects were found for the question",
      clarification: null,
      diagnostics
    };
  }

  let linkerCandidates = candidates;
  const candidateAmbiguity = buildCandidateClarification(input.question, candidates);
  if (candidateAmbiguity) {
    const optionIds = clarificationOptionIds(input);
    const selectedCandidateId = optionIds
      .map((optionId) => findCandidateIdByOptionId(candidateAmbiguity, optionId))
      .find((candidateId): candidateId is string => Boolean(candidateId));
    if (!selectedCandidateId) {
      const invalidForKind = Boolean(input.clarificationOptionId)
        && input.clarificationOptionId!.startsWith(`${candidateAmbiguity.clarification.kind}_`);
      return {
        ok: false,
        code: invalidForKind ? "clarification_option_invalid" : "schema_linking_ambiguous",
        message: invalidForKind
          ? "The selected clarification option is no longer valid"
          : "Multiple table or metric interpretations were found",
        clarification: candidateAmbiguity.clarification,
        diagnostics
      };
    }
    const competingIds = new Set(candidateAmbiguity.candidate_ids);
    linkerCandidates = candidates.filter((candidate) =>
      !competingIds.has(candidate.id) || candidate.id === selectedCandidateId
    );
  }

  const linker = await withTelemetrySpan("query.llm.schema_linker", {
    "pipeline.stage": "schema_linking"
  }, () => dependencies.linkTablesWithRouting({
    dataSourceId: input.dataSourceId,
    question: input.question,
    candidates: linkerCandidates,
    requestedProvider: input.requestedProvider,
    requestedModel: input.requestedModel,
    requestId: input.requestId
  }));
  diagnostics.linker = linker;

  let expanded = await withTelemetrySpan("query.schema.expand", {
    "pipeline.stage": "schema_expansion"
  }, () => dependencies.loadExpandedSchemaContext(
      input.dataSourceId,
      linker.selection.table_ids,
      { maxIntermediateHops: 2, maxAlternativePaths: 4 }
    ));
  diagnostics.expansion = expanded.expansion;

  const joinPathOptionIds = clarificationOptionIds(input).filter((optionId) => optionId.startsWith("join_path_"));
  if (expanded.expansion.status === "ambiguous" && joinPathOptionIds.length > 0) {
    const selectedPath = joinPathOptionIds
      .map((optionId) => findJoinPathByOptionId(expanded.expansion, optionId))
      .find((path): path is SchemaPath => Boolean(path));
    if (!selectedPath) {
      return {
        ok: false,
        code: "clarification_option_invalid",
        message: "The selected clarification option is no longer valid",
        clarification: buildJoinPathClarification(expanded.expansion),
        diagnostics
      };
    }
    expanded = await dependencies.loadResolvedSchemaContext(input.dataSourceId, expanded, selectedPath);
    diagnostics.expansion = expanded.expansion;
  }

  if (expanded.expansion.status !== "complete" || !expanded.context) {
    const ambiguous = expanded.expansion.status === "ambiguous";
    return {
      ok: false,
      code: ambiguous ? "schema_linking_ambiguous" : "schema_linking_disconnected",
      message: ambiguous
        ? "Multiple equally valid join paths were found"
        : "The selected schema objects could not be connected within the configured join-path limit",
      clarification: ambiguous ? buildJoinPathClarification(expanded.expansion) : null,
      diagnostics
    };
  }

  return {
    ok: true,
    context: expanded.context,
    ragDocuments: selectFinalRagDocuments(retrievedDocuments, expanded, finalRagLimit),
    diagnostics
  };
}

function clarificationOptionIds(input: PrepareGenerationContextInput): string[] {
  return [...new Set([
    input.clarificationOptionId,
    ...(input.resolvedClarificationOptionIds || [])
  ].map((value) => String(value || "").trim()).filter(Boolean))];
}

function selectFinalRagDocuments(
  documents: RagRetrievalDoc[],
  expanded: ExpandedSchemaContext,
  limit: number
): RagRetrievalDoc[] {
  const selectedIds = new Set(expanded.expansion.object_ids);
  const selectedSchemaRefs = expanded.context?.schemaObjects.map(
    (object) => `${object.schema_name}.${object.object_name}`
  ) || [];
  const relevantSchema = documents.filter((doc) => doc.doc_type === "schema" && selectedIds.has(String(doc.ref_id)));
  const examples = rankValidatedExamples(documents, {
    selectedSchemaRefs,
    maxExamples: Math.min(4, Math.max(1, Math.floor(limit / 3)))
  });
  const supporting = documents.filter((doc) => doc.doc_type !== "schema" && doc.doc_type !== "example");
  const schemaLimit = Math.max(0, limit - examples.length);
  return uniqueDocuments([
    ...relevantSchema.slice(0, schemaLimit),
    ...examples,
    ...supporting
  ]).slice(0, limit);
}

function summarizeCandidates(candidates: TableCandidate[]): SchemaLinkingDiagnostics["candidates"] {
  return candidates.map((candidate) => ({
    id: candidate.id,
    ref: `${candidate.schema_name}.${candidate.object_name}`,
    score: candidate.score,
    lexical_score: candidate.lexical_score,
    rag_score: candidate.rag_score,
    matched_terms: candidate.matched_terms
  }));
}

function uniqueDocuments(documents: RagRetrievalDoc[]): RagRetrievalDoc[] {
  const seen = new Set<string>();
  return documents.filter((document) => {
    if (seen.has(document.id)) {
      return false;
    }
    seen.add(document.id);
    return true;
  });
}

function positiveInteger(value: unknown, fallback: number): number {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : fallback;
}
