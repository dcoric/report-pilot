/**
 * Shared types and interface for LLM provider adapters.
 *
 * Every provider adapter (OpenAI, Gemini, DeepSeek, OpenRouter, custom) must
 * implement `LlmAdapter` so the routing layer in
 * `app/src/services/llmProviderRouting.js` and `app/src/services/embeddingRouter.js`
 * can treat them uniformly.
 */

/** Provider identifier surfaced on each adapter instance. */
export type LlmProvider = "openai" | "gemini" | "deepseek" | "openrouter" | string;

/** Options accepted by every adapter constructor. */
export interface LlmAdapterOptions {
  /** API key, already resolved (not an `env:` reference). */
  apiKey?: string;
  /** Default model used when the caller does not pass one. */
  defaultModel?: string;
  /** Request timeout in milliseconds (defaults to 15000). */
  timeoutMs?: number;
  /** Base URL for providers that allow overriding the host (custom, deepseek). */
  baseUrl?: string;
  /** Provider id override (used by the custom adapter to expose a stable name). */
  provider?: string;
}

/** Input for chat/completion-style generation. */
export interface LlmGenerateInput {
  /** Primary user message. */
  prompt: string;
  /** System prompt injected as the system role; providers map this appropriately. */
  systemPrompt?: string;
  /** Optional model override; falls back to the adapter's `defaultModel`. */
  model?: string;
  /** Sampling temperature; defaults to 0 in each provider implementation. */
  temperature?: number;
  /** Maximum tokens for the completion; defaults to 800. */
  maxTokens?: number;
}

/**
 * Normalized token usage shape. Provider-specific keys are preserved when the
 * upstream payload uses them (OpenAI / DeepSeek / OpenRouter), but Gemini is
 * mapped explicitly to these three keys.
 */
export interface LlmTokenUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
  /** Allow additional provider-specific usage keys without losing them. */
  [key: string]: unknown;
}

/** Result of `generate()`. */
export interface LlmGenerateResult {
  /** Decoded completion text. */
  text: string;
  /** Model id reported by the provider (falls back to the requested model). */
  model: string;
  /** Normalized token usage; null when the provider does not report it. */
  usage: LlmTokenUsage | null;
}

/** Input for embedding requests. */
export interface LlmEmbedInput {
  /** Texts to embed, in order. */
  texts: string[];
  /** Optional embedding model override. */
  model?: string;
}

/** Result of `embed()`. */
export interface LlmEmbedResult {
  /** One embedding vector per input text, in the same order. */
  vectors: number[][];
  /** Embedding model id (reported by provider or echoed from the request). */
  model: string;
}

/**
 * Shape of an HTTP-style error thrown by the adapters. Provider responses with
 * non-2xx status codes surface as `Error` instances with `statusCode` attached
 * by `httpClient.postJson`.
 */
export interface LlmAdapterError extends Error {
  statusCode?: number;
}

/**
 * Common interface implemented by every LLM provider adapter. Embedding
 * support is optional at runtime — providers that do not implement embeddings
 * throw from `embed()` rather than omitting the method, so the type signature
 * is uniform across providers.
 */
export interface LlmAdapter {
  /** Stable provider identifier (e.g. "openai"). */
  readonly provider: string;
  /** Throws when the adapter is missing required configuration. */
  healthCheck(): Promise<void>;
  /** Run a chat/completion request and return the normalized response. */
  generate(input: LlmGenerateInput): Promise<LlmGenerateResult>;
  /** Run `generate` and parse the returned text as JSON. */
  generateStructured(input: LlmGenerateInput): Promise<unknown>;
  /** Embed the input texts; throws if the provider does not support embeddings. */
  embed(input?: LlmEmbedInput): Promise<LlmEmbedResult>;
}
