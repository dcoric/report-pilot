import type { LlmAdapterError } from "./types";

export interface PostJsonOptions {
  /** Request timeout in milliseconds (defaults to 15000). */
  timeoutMs?: number;
  /** Extra headers merged on top of `Content-Type: application/json`. */
  headers?: Record<string, string>;
}

/** Provider response payloads are unknown JSON; callers downcast as needed. */
export type ProviderResponse = any;

/**
 * POST a JSON body to `url` and return the parsed JSON response.
 *
 * On non-2xx status codes throws an `Error` with a `statusCode` field attached,
 * matching the `LlmAdapterError` shape so callers can react to HTTP errors.
 */
async function postJson(
  url: string,
  body: unknown,
  opts: PostJsonOptions = {}
): Promise<ProviderResponse> {
  const timeoutMs = Number(opts.timeoutMs || 15000);
  const headers: Record<string, string> = Object.assign(
    {
      "Content-Type": "application/json"
    },
    opts.headers || {}
  );

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: controller.signal
    });

    const text = await response.text();
    let parsed: ProviderResponse = null;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch {
      parsed = null;
    }

    if (!response.ok) {
      const error: LlmAdapterError = new Error(
        `HTTP ${response.status} from provider: ${parsed?.error?.message || text || "unknown error"}`
      );
      error.statusCode = response.status;
      throw error;
    }

    return parsed;
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Parse a JSON object out of a model's free-form text response. Handles
 * fenced code blocks (```json ... ```) and trims to the first/last brace as a
 * last resort. Throws when nothing parseable is found.
 */
export function extractJsonObject(text: unknown): unknown {
  const raw = String(text || "").trim();
  if (!raw) {
    throw new Error("Model response is empty");
  }

  try {
    return JSON.parse(raw);
  } catch {
    const fenced = raw.match(/```json\s*([\s\S]*?)```/i);
    if (fenced && fenced[1]) {
      return JSON.parse(fenced[1].trim());
    }

    const firstBrace = raw.indexOf("{");
    const lastBrace = raw.lastIndexOf("}");
    if (firstBrace !== -1 && lastBrace !== -1 && lastBrace > firstBrace) {
      return JSON.parse(raw.slice(firstBrace, lastBrace + 1));
    }
    throw new Error("Could not parse JSON from model response");
  }
}

/**
 * Resolve an API key from a provider configuration reference.
 *
 * Supported reference forms:
 * - `env:NAME` — read from `process.env.NAME`
 * - `plain:value` — use `value` literally
 * - `NAME` — look up `process.env.NAME`, otherwise treat as a literal value
 *
 * If `ref` is empty/missing, falls back to `process.env[defaultEnvKey]`.
 */
export function resolveApiKey(ref?: string | null, defaultEnvKey?: string | null): string {
  const candidates: string[] = [];
  if (ref) {
    candidates.push(ref);
  }
  if (defaultEnvKey) {
    candidates.push(`env:${defaultEnvKey}`);
  }

  for (const candidate of candidates) {
    if (!candidate) {
      continue;
    }
    if (candidate.startsWith("env:")) {
      const envName = candidate.slice(4).trim();
      if (envName && process.env[envName]) {
        return process.env[envName] as string;
      }
      continue;
    }
    if (candidate.startsWith("plain:")) {
      return candidate.slice(6);
    }
    if (process.env[candidate]) {
      return process.env[candidate] as string;
    }
    return candidate;
  }

  return "";
}

module.exports = {
  postJson,
  extractJsonObject,
  resolveApiKey
};
