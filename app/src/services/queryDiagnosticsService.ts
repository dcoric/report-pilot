import { logEvent } from "../lib/observability";
import type { ProviderAttempt } from "./llmSqlService";
import type { SchemaLinkingDiagnostics } from "./queryGenerationContextService";

const MAX_TABLE_IDS = 20;
const MAX_PROVIDER_ATTEMPTS = 8;

export interface QueryDiagnosticInput {
  requestId?: string | null;
  sessionId: string;
  outcome: "succeeded" | "failed";
  terminalStage: "schema_linking" | "generation" | "validation" | "budget" | "execution";
  errorCode?: string | null;
  durationMs: number;
  schemaLinkingDurationMs: number;
  schemaLinking: SchemaLinkingDiagnostics | null;
  expandedTableIds: string[];
  ragDocumentCount: number;
  ragExampleCount: number;
  provider: string;
  model: string | null;
  providerAttempts: ProviderAttempt[];
  repairCount: number;
  linkerPromptChars: number;
  generationPromptChars: number;
  repairPromptChars: number;
  tokenUsage: unknown;
  executionDurationMs?: number | null;
}

export interface QueryDiagnosticPayload {
  request_id: string | null;
  session_id: string;
  outcome: "succeeded" | "failed";
  terminal_stage: QueryDiagnosticInput["terminalStage"];
  error_code: string | null;
  duration_ms: number;
  schema_linking: {
    candidate_count: number;
    candidate_table_ids: string[];
    selected_core_table_ids: string[];
    expanded_table_ids: string[];
    connector_table_ids: string[];
    join_edge_count: number;
    expansion_status: string;
    linker_status: string;
    fallback_used: boolean;
    fallback_category: "none" | "no_provider" | "provider_failure";
    clarification_required: boolean;
    clarification_option_count: number;
  } | null;
  retrieval: { rag_document_count: number; example_count: number };
  generation: {
    provider: string;
    model: string | null;
    attempts: Array<{
      provider: string;
      model: string | null;
      stage: string;
      status: string;
      status_code: number | null;
      latency_ms: number;
    }>;
    attempts_truncated: boolean;
    fallback_used: boolean;
    repair_count: number;
    prompt_chars: {
      linker: number;
      generation: number;
      repair: number;
      total: number;
    };
    token_usage: {
      prompt_tokens: number;
      completion_tokens: number;
      total_tokens: number;
    };
  };
  stage_latency_ms: {
    schema_linking: number;
    generation: number;
    repair: number;
    execution: number;
  };
}

export function buildQueryDiagnostic(input: QueryDiagnosticInput): QueryDiagnosticPayload {
  const linker = input.schemaLinking?.linker;
  const expansion = input.schemaLinking?.expansion;
  const attempts = input.providerAttempts.slice(0, MAX_PROVIDER_ATTEMPTS);
  const linkerAttempts = linker?.attempts || [];
  const generationLatency = input.providerAttempts
    .filter((attempt) => attempt.stage !== "repair")
    .reduce((total, attempt) => total + boundedNumber(attempt.latency_ms), 0);
  const repairLatency = input.providerAttempts
    .filter((attempt) => attempt.stage === "repair")
    .reduce((total, attempt) => total + boundedNumber(attempt.latency_ms), 0);

  return {
    request_id: input.requestId || null,
    session_id: input.sessionId,
    outcome: input.outcome,
    terminal_stage: input.terminalStage,
    error_code: input.errorCode ? boundedLabel(input.errorCode, 80) : null,
    duration_ms: boundedNumber(input.durationMs),
    schema_linking: input.schemaLinking ? {
      candidate_count: input.schemaLinking.candidates.length,
      candidate_table_ids: boundIds(input.schemaLinking.candidates.map((candidate) => candidate.id)),
      selected_core_table_ids: boundIds(linker?.selection.table_ids || []),
      expanded_table_ids: boundIds(input.expandedTableIds),
      connector_table_ids: boundIds(expansion?.connector_object_ids || []),
      join_edge_count: expansion?.edges.length || 0,
      expansion_status: expansion?.status || "not_run",
      linker_status: linker?.status || "not_run",
      fallback_used: linker?.status === "fallback",
      fallback_category: linker?.status !== "fallback"
        ? "none"
        : linkerAttempts.length === 0 ? "no_provider" : "provider_failure",
      clarification_required: expansion?.status === "ambiguous",
      clarification_option_count: (expansion?.ambiguities || [])
        .reduce((total, ambiguity) => total + ambiguity.alternatives.length, 0)
    } : null,
    retrieval: {
      rag_document_count: Math.max(0, Math.floor(input.ragDocumentCount)),
      example_count: Math.max(0, Math.floor(input.ragExampleCount))
    },
    generation: {
      provider: boundedLabel(input.provider, 64),
      model: input.model ? boundedLabel(input.model, 120) : null,
      attempts: attempts.map((attempt) => ({
        provider: boundedLabel(attempt.provider, 64),
        model: attempt.model ? boundedLabel(attempt.model, 120) : null,
        stage: attempt.stage || "generation",
        status: attempt.status,
        status_code: attempt.status_code,
        latency_ms: boundedNumber(attempt.latency_ms)
      })),
      attempts_truncated: input.providerAttempts.length > MAX_PROVIDER_ATTEMPTS,
      fallback_used: input.provider === "local-fallback",
      repair_count: Math.max(0, Math.floor(input.repairCount)),
      prompt_chars: {
        linker: boundedNumber(input.linkerPromptChars),
        generation: boundedNumber(input.generationPromptChars),
        repair: boundedNumber(input.repairPromptChars),
        total: boundedNumber(input.linkerPromptChars + input.generationPromptChars + input.repairPromptChars)
      },
      token_usage: sumTokenUsage(input.tokenUsage)
    },
    stage_latency_ms: {
      schema_linking: boundedNumber(input.schemaLinkingDurationMs),
      generation: generationLatency,
      repair: repairLatency,
      execution: boundedNumber(input.executionDurationMs || 0)
    }
  };
}

export function emitQueryDiagnostic(input: QueryDiagnosticInput): void {
  logEvent(
    "query_generation_diagnostics",
    { ...buildQueryDiagnostic(input) },
    input.outcome === "failed" ? "warn" : "info"
  );
}

function boundIds(ids: string[]): string[] {
  return ids.slice(0, MAX_TABLE_IDS).map(String);
}

function boundedNumber(value: unknown): number {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.round(number) : 0;
}

function boundedLabel(value: unknown, maxLength: number): string {
  return String(value || "unknown").slice(0, maxLength);
}

function sumTokenUsage(value: unknown): QueryDiagnosticPayload["generation"]["token_usage"] {
  const totals = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };
  collectTokenUsage(value, totals, 0);
  if (totals.total_tokens === 0) {
    totals.total_tokens = totals.prompt_tokens + totals.completion_tokens;
  }
  return totals;
}

function collectTokenUsage(value: unknown, totals: QueryDiagnosticPayload["generation"]["token_usage"], depth: number): void {
  if (!value || typeof value !== "object" || depth > 2) return;
  const record = value as Record<string, unknown>;
  const hasUsage = "prompt_tokens" in record || "completion_tokens" in record || "total_tokens" in record;
  if (hasUsage) {
    totals.prompt_tokens += boundedNumber(record.prompt_tokens);
    totals.completion_tokens += boundedNumber(record.completion_tokens);
    totals.total_tokens += boundedNumber(record.total_tokens);
    return;
  }
  for (const child of Object.values(record)) {
    collectTokenUsage(child, totals, depth + 1);
  }
}
