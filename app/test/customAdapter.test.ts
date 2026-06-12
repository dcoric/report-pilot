import { test } from "node:test";
import assert from "node:assert/strict";

import { CustomAdapter } from "../src/adapters/llm/customAdapter";

test("healthCheck throws when baseUrl is missing", async () => {
  const adapter = new CustomAdapter({
    apiKey: "secret"
  });

  await assert.rejects(adapter.healthCheck(), /base_url is not configured/i);
});

test("healthCheck throws when apiKey is missing", async () => {
  const adapter = new CustomAdapter({
    baseUrl: "http://localhost:11434/v1"
  });

  await assert.rejects(adapter.healthCheck(), /api key is not configured/i);
});

test("healthCheck resolves when baseUrl and apiKey are set", async () => {
  const adapter = new CustomAdapter({
    baseUrl: "http://localhost:11434/v1",
    apiKey: "secret"
  });

  await assert.doesNotReject(adapter.healthCheck());
});

test("generate sends chat completion requests with bearer auth", async () => {
  const originalFetch = global.fetch;
  const requests: Array<{ url: string; options: RequestInit }> = [];

  global.fetch = (async (url: string, options: RequestInit) => {
    requests.push({ url, options });
    return {
      ok: true,
      text: async () => JSON.stringify({
        choices: [{ message: { content: "SELECT 1;" } }],
        model: "llama3.2",
        usage: { total_tokens: 12 }
      })
    };
  }) as unknown as typeof fetch;

  try {
    const adapter = new CustomAdapter({
      provider: "ollama-local",
      apiKey: "secret",
      baseUrl: "http://localhost:11434/v1/",
      defaultModel: "llama3.2"
    });

    const result = await adapter.generate({
      prompt: "Return SQL",
      systemPrompt: "System prompt",
      temperature: 0.3,
      maxTokens: 200
    });

    assert.equal(requests.length, 1);
    assert.equal(requests[0].url, "http://localhost:11434/v1/chat/completions");
    const headers = requests[0].options.headers as Record<string, string>;
    assert.equal(headers.Authorization, "Bearer secret");

    const payload = JSON.parse(requests[0].options.body as string);
    assert.equal(payload.model, "llama3.2");
    assert.equal(payload.temperature, 0.3);
    assert.equal(payload.max_tokens, 200);
    assert.deepEqual(payload.messages, [
      { role: "system", content: "System prompt" },
      { role: "user", content: "Return SQL" }
    ]);

    assert.equal(result.text, "SELECT 1;");
    assert.equal(result.model, "llama3.2");
    assert.deepEqual(result.usage, { total_tokens: 12 });
  } finally {
    global.fetch = originalFetch;
  }
});

test("generateStructured parses JSON from the provider response", async () => {
  const originalFetch = global.fetch;

  global.fetch = (async () => ({
    ok: true,
    text: async () => JSON.stringify({
      choices: [{ message: { content: "{\"sql\":\"SELECT 1;\"}" } }],
      model: "llama3.2"
    })
  })) as unknown as typeof fetch;

  try {
    const adapter = new CustomAdapter({
      apiKey: "secret",
      baseUrl: "http://localhost:11434/v1"
    });

    const result = await adapter.generateStructured({
      prompt: "Return JSON"
    });

    assert.deepEqual(result, { sql: "SELECT 1;" });
  } finally {
    global.fetch = originalFetch;
  }
});

test("embed throws because custom adapters do not support embeddings", async () => {
  const adapter = new CustomAdapter({
    apiKey: "secret",
    baseUrl: "http://localhost:11434/v1"
  });

  await assert.rejects(adapter.embed(), /not supported/i);
});
