import { test } from "node:test";
import assert from "node:assert/strict";

import { normalizeProviderUpsertInput } from "../src/services/providerConfigService";

const KNOWN_PROVIDERS = new Set(["openai", "gemini", "deepseek", "openrouter"]);

test("provider upsert preserves existing api_key_ref when omitted", () => {
  const result = normalizeProviderUpsertInput(
    {
      provider: "openai",
      default_model: "gpt-5.2",
      enabled: true
    },
    {
      api_key_ref: "env:OPENAI_API_KEY"
    },
    KNOWN_PROVIDERS
  );

  assert.equal(result.apiKeyRef, "env:OPENAI_API_KEY");
});

test("provider upsert rejects explicit empty api_key_ref", () => {
  assert.throws(
    () =>
      normalizeProviderUpsertInput(
        {
          provider: "openai",
          api_key_ref: "   ",
          default_model: "gpt-5.2",
          enabled: true
        },
        {
          api_key_ref: "env:OPENAI_API_KEY"
        },
        KNOWN_PROVIDERS
      ),
    /api_key_ref must be a non-empty string/i
  );
});

test("provider upsert requires api_key_ref for new providers", () => {
  assert.throws(
    () =>
      normalizeProviderUpsertInput(
        {
          provider: "openai",
          default_model: "gpt-5.2",
          enabled: true
        },
        null,
        KNOWN_PROVIDERS
      ),
    /api_key_ref is required/i
  );
});
