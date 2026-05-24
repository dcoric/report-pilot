import { logEvent } from "../lib/observability";

const LLM_DEBUG_LOG_ENABLED = String(process.env.LLM_DEBUG_LOG || "false") === "true";
const LLM_DEBUG_MAX_CHARS = clampPositiveInt(process.env.LLM_DEBUG_MAX_CHARS, 16000);

export interface NormalizedTokenUsage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
}

export interface LlmDebugPayload {
  prompt?: string;
  system_prompt?: string;
  sql?: string;
  [key: string]: unknown;
}

export function normalizeTokenUsage(raw: unknown): NormalizedTokenUsage | null {
  if (!raw || typeof raw !== "object") {
    return null;
  }
  const r = raw as Record<string, unknown>;

  const promptTokens = toFiniteNumber(r.prompt_tokens ?? r.promptTokenCount);
  const completionTokens = toFiniteNumber(r.completion_tokens ?? r.candidatesTokenCount ?? r.output_tokens);
  const totalTokens = toFiniteNumber(r.total_tokens ?? r.totalTokenCount);

  return {
    prompt_tokens: promptTokens || 0,
    completion_tokens: completionTokens || 0,
    total_tokens: totalTokens || (promptTokens || 0) + (completionTokens || 0)
  };
}

export function normalizeStatusCode(value: unknown): number | null {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

export function logLlmDebug(payload: LlmDebugPayload): void {
  if (!LLM_DEBUG_LOG_ENABLED) {
    return;
  }
  const safePayload: LlmDebugPayload = Object.assign({}, payload);
  if (typeof safePayload.prompt === "string") {
    safePayload.prompt = truncateText(safePayload.prompt);
  }
  if (typeof safePayload.system_prompt === "string") {
    safePayload.system_prompt = truncateText(safePayload.system_prompt);
  }
  if (typeof safePayload.sql === "string") {
    safePayload.sql = truncateText(safePayload.sql);
  }
  logEvent("llm_debug", safePayload);
}

function toFiniteNumber(value: unknown): number | null {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function truncateText(value: unknown): string {
  const text = String(value || "");
  if (text.length <= LLM_DEBUG_MAX_CHARS) {
    return text;
  }
  return `${text.slice(0, LLM_DEBUG_MAX_CHARS)}... [truncated ${text.length - LLM_DEBUG_MAX_CHARS} chars]`;
}

function clampPositiveInt(raw: unknown, fallback: number): number {
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) {
    return fallback;
  }
  return Math.floor(n);
}
