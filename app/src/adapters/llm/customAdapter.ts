import type {
  LlmAdapter,
  LlmAdapterOptions,
  LlmEmbedResult,
  LlmGenerateInput,
  LlmGenerateResult
} from "./types";

const { postJson, extractJsonObject } = require("./httpClient");

/**
 * Adapter for self-hosted / OpenAI-compatible providers (e.g. Ollama running
 * with the OpenAI-compatible frontend). The caller supplies `baseUrl` and
 * `provider` so this adapter can stand in for any OpenAI-shaped REST endpoint.
 * Embeddings are not assumed to be supported and `embed()` throws.
 */
class CustomAdapter implements LlmAdapter {
  provider: string;
  apiKey: string;
  defaultModel: string;
  timeoutMs: number;
  baseUrl: string;

  constructor(opts: LlmAdapterOptions = {}) {
    this.provider = opts.provider || "custom";
    this.apiKey = opts.apiKey || "";
    this.defaultModel = opts.defaultModel || "";
    this.timeoutMs = Number(opts.timeoutMs || 15000);
    this.baseUrl = String(opts.baseUrl || "").replace(/\/+$/, "");
  }

  async healthCheck(): Promise<void> {
    if (!this.baseUrl) {
      throw new Error("Custom provider base_url is not configured");
    }
    if (!this.apiKey) {
      throw new Error("Custom provider API key is not configured");
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

    const response = await postJson(`${this.baseUrl}/chat/completions`, payload, {
      timeoutMs: this.timeoutMs,
      headers: {
        Authorization: `Bearer ${this.apiKey}`
      }
    });

    const text = response?.choices?.[0]?.message?.content;
    if (!text) {
      throw new Error("Custom provider returned an empty completion");
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
    throw new Error("embed() is not supported for the custom adapter");
  }
}

module.exports = {
  CustomAdapter
};
