const { logEvent } = require("../lib/observability");

const LLM_DEBUG_LOG_ENABLED = String(process.env.LLM_DEBUG_LOG || "false") === "true";
const LLM_DEBUG_MAX_CHARS = clampPositiveInt(process.env.LLM_DEBUG_MAX_CHARS, 16000);

function normalizeTokenUsage(raw) {
  if (!raw || typeof raw !== "object") {
    return null;
  }

  const promptTokens = toFiniteNumber(raw.prompt_tokens ?? raw.promptTokenCount);
  const completionTokens = toFiniteNumber(raw.completion_tokens ?? raw.candidatesTokenCount ?? raw.output_tokens);
  const totalTokens = toFiniteNumber(raw.total_tokens ?? raw.totalTokenCount);

  return {
    prompt_tokens: promptTokens || 0,
    completion_tokens: completionTokens || 0,
    total_tokens: totalTokens || (promptTokens || 0) + (completionTokens || 0)
  };
}

function normalizeStatusCode(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function logLlmDebug(payload) {
  if (!LLM_DEBUG_LOG_ENABLED) {
    return;
  }
  const safePayload = Object.assign({}, payload);
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

function toFiniteNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function truncateText(value) {
  const text = String(value || "");
  if (text.length <= LLM_DEBUG_MAX_CHARS) {
    return text;
  }
  return `${text.slice(0, LLM_DEBUG_MAX_CHARS)}... [truncated ${text.length - LLM_DEBUG_MAX_CHARS} chars]`;
}

function clampPositiveInt(raw, fallback) {
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) {
    return fallback;
  }
  return Math.floor(n);
}

module.exports = {
  logLlmDebug,
  normalizeStatusCode,
  normalizeTokenUsage
};
