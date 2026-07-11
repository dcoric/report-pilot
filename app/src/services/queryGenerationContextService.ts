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
  type ExpandedSchemaContext,
  type SchemaExpansion
} from "./schemaGraphService";
import type { QueryContext } from "./queryOrchestrationStore";
import type { RagRetrievalDoc } from "./ragRetrieval";

const { retrieveRagContext } = ragRetrieval;

export interface PrepareGenerationContextInput {
  dataSourceId: string;
  question: string;
  requestedProvider?: string | null;
  requestedModel?: string | null;
  requestId?: string | null;
  candidateLimit?: number;
  finalRagLimit?: number;
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
    code: "no_schema_candidates" | "schema_linking_ambiguous" | "schema_linking_disconnected";
    message: string;
    diagnostics: SchemaLinkingDiagnostics;
  };

export interface GenerationContextDependencies {
  loadTableCards: (dataSourceId: string) => Promise<TableCard[]>;
  retrieveRagContext: typeof retrieveRagContext;
  linkTablesWithRouting: typeof linkTablesWithRouting;
  loadExpandedSchemaContext: typeof loadExpandedSchemaContext;
}

const defaultDependencies: GenerationContextDependencies = {
  loadTableCards,
  retrieveRagContext,
  linkTablesWithRouting,
  loadExpandedSchemaContext
};

export async function prepareQueryGenerationContext(
  input: PrepareGenerationContextInput,
  dependencies: GenerationContextDependencies = defaultDependencies
): Promise<PrepareGenerationContextResult> {
  const candidateLimit = positiveInteger(input.candidateLimit, 15);
  const finalRagLimit = positiveInteger(input.finalRagLimit, 12);
  const retrievalLimit = Math.max(candidateLimit * 3, finalRagLimit);
  const [cards, retrievedDocuments] = await Promise.all([
    dependencies.loadTableCards(input.dataSourceId),
    dependencies.retrieveRagContext(input.dataSourceId, input.question, { limit: retrievalLimit })
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
      diagnostics
    };
  }

  const linker = await dependencies.linkTablesWithRouting({
    dataSourceId: input.dataSourceId,
    question: input.question,
    candidates,
    requestedProvider: input.requestedProvider,
    requestedModel: input.requestedModel,
    requestId: input.requestId
  });
  diagnostics.linker = linker;

  const expanded = await dependencies.loadExpandedSchemaContext(
    input.dataSourceId,
    linker.selection.table_ids,
    { maxIntermediateHops: 2, maxAlternativePaths: 4 }
  );
  diagnostics.expansion = expanded.expansion;

  if (expanded.expansion.status !== "complete" || !expanded.context) {
    const ambiguous = expanded.expansion.status === "ambiguous";
    return {
      ok: false,
      code: ambiguous ? "schema_linking_ambiguous" : "schema_linking_disconnected",
      message: ambiguous
        ? "Multiple equally valid join paths were found; refine the question or approve a join policy"
        : "The selected schema objects could not be connected within the configured join-path limit",
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

function selectFinalRagDocuments(
  documents: RagRetrievalDoc[],
  expanded: ExpandedSchemaContext,
  limit: number
): RagRetrievalDoc[] {
  const selectedIds = new Set(expanded.expansion.object_ids);
  const relevantSchema = documents.filter((doc) => doc.doc_type === "schema" && selectedIds.has(String(doc.ref_id)));
  const supporting = documents.filter((doc) => doc.doc_type !== "schema");
  return uniqueDocuments([...relevantSchema, ...supporting]).slice(0, limit);
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
