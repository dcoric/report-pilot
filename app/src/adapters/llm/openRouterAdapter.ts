import type {
  LlmAdapter,
  LlmAdapterOptions,
  LlmEmbedResult,
  LlmGenerateInput,
  LlmGenerateResult
} from "./types";

const { postJson, extractJsonObject } = require("./httpClient");

/**
 * Adapter for OpenRouter's OpenAI-compatible chat completions endpoint.
 * Optional `HTTP-Referer` / `X-Title` headers are forwarded from environment
 * variables to satisfy OpenRouter's attribution guidelines. Embeddings are not
 * exposed by this provider, so `embed()` throws.
 */
export class OpenRouterAdapter implements LlmAdapter {
  readonly provider: string;
  apiKey: string;
  defaultModel: string;
  timeoutMs: number;
  baseUrl: string;

  constructor(opts: LlmAdapterOptions = {}) {
    this.provider = "openrouter";
    this.apiKey = opts.apiKey || "";
    this.defaultModel = opts.defaultModel || "google/gemma-4-31b-it";
    this.timeoutMs = Number(opts.timeoutMs || 15000);
    this.baseUrl = "https://openrouter.ai/api/v1";
  }

  async healthCheck(): Promise<void> {
    if (!this.apiKey) {
      throw new Error("OpenRouter API key is not configured");
    }
  }

  async generate(input: LlmGenerateInput): Promise<LlmGenerateResult> {
    await this.healthCheck();

    const model = input.model || this.defaultModel;
    const payload = {
      model,
      temperature: input.temperature ?? 0,
      max_tokens: input.maxTokens ?? 800,
      messages: [
        {
          role: "system",
          content: input.systemPrompt || "You are a SQL generation assistant."
        },
        {
          role: "user",
          content: input.prompt
        }
      ]
    };

    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.apiKey}`
    };
    if (process.env.OPENROUTER_SITE_URL) {
      headers["HTTP-Referer"] = process.env.OPENROUTER_SITE_URL;
    }
    if (process.env.OPENROUTER_SITE_NAME) {
      headers["X-Title"] = process.env.OPENROUTER_SITE_NAME;
    }

    const response = await postJson(`${this.baseUrl}/chat/completions`, payload, {
      timeoutMs: this.timeoutMs,
      headers
    });

    const text = response?.choices?.[0]?.message?.content;
    if (!text) {
      throw new Error("OpenRouter returned an empty completion");
    }

    return {
      text,
      model: response?.model || model,
      usage: response?.usage || null
    };
  }

  async generateStructured(input: LlmGenerateInput): Promise<unknown> {
    const output = await this.generate(input);
    return extractJsonObject(output.text);
  }

  async embed(): Promise<LlmEmbedResult> {
    throw new Error("embed() is not supported for the OpenRouter adapter");
  }
}

module.exports = {
  OpenRouterAdapter
};
