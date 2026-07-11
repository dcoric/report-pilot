import "./helpers/setupEnv";
import { test } from "node:test";
import assert from "node:assert/strict";

import { buildQueryDiagnostic } from "../src/services/queryDiagnosticsService";

test("query diagnostics are bounded, correlated, and exclude sensitive content", () => {
  const ids = Array.from({ length: 25 }, (_, index) => `table-${index}`);
  const payload = buildQueryDiagnostic({
    requestId: "request-1",
    sessionId: "session-1",
    outcome: "succeeded",
    terminalStage: "execution",
    durationMs: 120.4,
    schemaLinkingDurationMs: 30,
    schemaLinking: {
      candidates: ids.map((id) => ({ id, ref: `public.${id}`, score: 1, lexical_score: 1, rag_score: 0, matched_terms: ["secret-question-term"] })),
      linker: {
        selection: { table_ids: ids, concepts: ["secret-concept"], reason: "secret reason" },
        status: "fallback",
        provider: "candidate-fallback",
        model: null,
        attempts: [],
        fallback_reason: "secret provider error",
        prompt_version: "v3-schema-linker",
        prompt_chars: 500
      },
      expansion: {
        status: "ambiguous",
        core_object_ids: [ids[0], ids[1]],
        object_ids: [ids[0]],
        connector_object_ids: [],
        edges: [],
        paths: [],
        ambiguities: [{
          target_object_id: ids[1],
          alternatives: [
            { object_ids: [ids[0], ids[1]], edge_ids: ["edge-1"], edges: [], approved_policy_count: 0 },
            { object_ids: [ids[0], ids[1]], edge_ids: ["edge-2"], edges: [], approved_policy_count: 0 }
          ]
        }],
        unresolved_object_ids: []
      }
    },
    expandedTableIds: ids,
    ragDocumentCount: 12,
    ragExampleCount: 3,
    provider: "local-fallback",
    model: "rule-based-v0",
    providerAttempts: Array.from({ length: 10 }, () => ({
      provider: "openai",
      model: "model",
      status: "failed" as const,
      status_code: 500,
      latency_ms: 7,
      error: "secret provider response",
      stage: "generation" as const
    })),
    repairCount: 1,
    linkerPromptChars: 500,
    generationPromptChars: 800,
    repairPromptChars: 600,
    tokenUsage: {
      generation: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      repair: { prompt_tokens: 8, completion_tokens: 4, total_tokens: 12 }
    },
    executionDurationMs: 20
  });

  assert.equal(payload.request_id, "request-1");
  assert.equal(payload.schema_linking?.candidate_table_ids.length, 20);
  assert.equal(payload.generation.attempts.length, 8);
  assert.equal(payload.generation.attempts_truncated, true);
  assert.deepEqual(payload.retrieval, { rag_document_count: 12, example_count: 3 });
  assert.equal(payload.schema_linking?.clarification_required, true);
  assert.equal(payload.schema_linking?.clarification_option_count, 2);
  assert.deepEqual(payload.generation.token_usage, { prompt_tokens: 18, completion_tokens: 9, total_tokens: 27 });
  const serialized = JSON.stringify(payload);
  assert.doesNotMatch(serialized, /secret/);
  assert.doesNotMatch(serialized, /question|sql|connection|parameter/i);
});
