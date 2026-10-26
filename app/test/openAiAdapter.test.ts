import { test } from "node:test";
import assert from "node:assert/strict";
import { OpenAiAdapter } from "../src/adapters/llm/openAiAdapter";

for (const model of ["gpt-6.1-sol", "gpt-6.1-sol-2026-10-01", "gpt-5.2", "gpt-4o"]) {
  test(`generate uses compatible completion parameters when model is ${model}`, async (t) => {
    // Given an HTTP boundary that rejects unsupported model parameters.
    t.mock.method(globalThis, "fetch", async (_url: unknown, options?: RequestInit) => {
      assert.equal(typeof options?.body, "string");
      if (typeof options?.body !== "string") throw new TypeError("Expected JSON request body");
      const payload: Record<string, unknown> = JSON.parse(options.body);
      if (model.startsWith("gpt-6.1-sol")) {
        assert.equal(payload.max_tokens, undefined);
        assert.equal(payload.temperature, undefined);
        assert.equal(payload.reasoning_effort, "low");
        assert.equal(payload.max_completion_tokens, 900);
      } else {
        assert.equal(payload.temperature, 0.2);
        assert.equal(payload.reasoning_effort, undefined);
        assert.equal(model === "gpt-5.2" ? payload.max_completion_tokens : payload.max_tokens, 900);
      }
      return new Response(JSON.stringify({ choices: [{ message: { content: "SELECT 1;" } }], model }));
    });
    const adapter = new OpenAiAdapter({ apiKey: "test-key", defaultModel: "gpt-4o" });

    // When the caller overrides the default model.
    const result = await adapter.generate({ model, prompt: "Return SQL", maxTokens: 900, temperature: 0.2 });

    // Then the response is usable with the selected model's request contract.
    assert.equal(result.text, "SELECT 1;");
    assert.equal(result.model, model);
  });
}
