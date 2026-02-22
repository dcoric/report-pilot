const { postJson, extractJsonObject } = require("./httpClient");

class OpenAiAdapter {
  constructor(opts = {}) {
    this.provider = "openai";
    this.apiKey = opts.apiKey || "";
    this.defaultModel = opts.defaultModel || "gpt-5.2-mini";
    this.timeoutMs = Number(opts.timeoutMs || 15000);
  }

  async healthCheck() {
    if (!this.apiKey) {
      throw new Error("OpenAI API key is not configured");
    }
  }

  async generate(input) {
    await this.healthCheck();

    const model = input.model || this.defaultModel;
    const maxTokens = input.maxTokens ?? 800;
    const payload = {
      model,
      temperature: input.temperature ?? 0,
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
    if (usesCompletionTokenParam(model)) {
      payload.max_completion_tokens = maxTokens;
    } else {
      payload.max_tokens = maxTokens;
    }

    const response = await postJson("https://api.openai.com/v1/chat/completions", payload, {
      timeoutMs: this.timeoutMs,
      headers: {
        Authorization: `Bearer ${this.apiKey}`
      }
    });

    const text = response?.choices?.[0]?.message?.content;
    if (!text) {
      throw new Error("OpenAI returned an empty completion");
    }

    return {
      text,
      model: response?.model || model,
      usage: response?.usage || null
    };
  }

  async generateStructured(input) {
    const output = await this.generate(input);
    return extractJsonObject(output.text);
  }

  async embed(input) {
    await this.healthCheck();

    const model = input.model || "text-embedding-3-small";
    const texts = Array.isArray(input.texts) ? input.texts : [];
    if (texts.length === 0) {
      throw new Error("embed input texts are required");
    }

    const payload = {
      model,
      input: texts
    };

    const response = await postJson("https://api.openai.com/v1/embeddings", payload, {
      timeoutMs: this.timeoutMs,
      headers: {
        Authorization: `Bearer ${this.apiKey}`
      }
    });

    const vectors = Array.isArray(response?.data)
      ? response.data
        .sort((a, b) => a.index - b.index)
        .map((item) => item.embedding)
      : [];

    if (vectors.length !== texts.length) {
      throw new Error("OpenAI embedding response size mismatch");
    }

    return {
      vectors,
      model: response?.model || model
    };
  }
}

function usesCompletionTokenParam(model) {
  return /^gpt-5(?:[.-]|$)/i.test(String(model || ""));
}

module.exports = {
  OpenAiAdapter
};
