import "./helpers/setupEnv";
import { test } from "node:test";
import assert from "node:assert/strict";

import { rankValidatedExamples } from "../src/services/exampleRankingService";
import type { RagRetrievalDoc } from "../src/services/ragRetrieval";

test("ranking excludes unvalidated, incompatible, and low-quality feedback examples", () => {
  const documents = [
    example("manual", "manual", 0.7, ["public.payment"], 1),
    example("feedback-good", "feedback", 1, ["public.payment"], 1),
    example("feedback-low", "feedback", 0.4, ["public.payment"], 20),
    example("wrong-schema", "manual", 1, ["public.inventory"], 20),
    example("rejected", "manual", 1, ["public.payment"], 20, "rejected"),
    {
      ...example("unknown-source", "manual", 1, ["public.payment"], 20),
      metadata_json: {
        source: "imported",
        quality_score: 1,
        validation_state: "validated",
        schema_refs: ["public.payment"]
      }
    }
  ];

  const ranked = rankValidatedExamples(documents, {
    selectedSchemaRefs: ["PUBLIC.PAYMENT"]
  });

  assert.deepEqual(ranked.map((document) => document.id), ["feedback-good", "manual"]);
});

test("ranking is deterministic, removes near duplicates, and enforces count and character budgets", () => {
  const duplicate = example("duplicate", "feedback", 1, ["public.payment"], 30);
  duplicate.content = "example question Revenue by day\nexample sql SELECT day, SUM(amount) FROM public.payment GROUP BY day";
  const original = example("original", "manual", 1, ["public.payment"], 30);
  original.content = "example question Daily revenue\nexample sql SELECT day, SUM(amount) FROM public.payment GROUP BY day";
  const second = example("second", "manual", 0.9, ["public.payment"], 20);
  const tooLarge = example("too-large", "manual", 1, ["public.payment"], 100);
  tooLarge.content = "x".repeat(500);

  const options = {
    selectedSchemaRefs: ["public.payment"],
    maxExamples: 2,
    maxChars: original.content.length + second.content.length
  };
  const first = rankValidatedExamples([second, duplicate, tooLarge, original], options);
  const secondRun = rankValidatedExamples([original, tooLarge, duplicate, second], options);

  assert.deepEqual(first.map((document) => document.id), ["original", "second"]);
  assert.deepEqual(secondRun.map((document) => document.id), ["original", "second"]);
});

function example(
  id: string,
  source: "manual" | "feedback",
  quality: number,
  schemaRefs: string[],
  relevance: number,
  validationState: "validated" | "rejected" = "validated"
): RagRetrievalDoc {
  return {
    id,
    doc_type: "example",
    ref_id: id,
    content: `example question ${id}\nexample sql SELECT amount FROM public.payment WHERE id = '${id}'`,
    metadata_json: {
      source,
      quality_score: quality,
      validation_state: validationState,
      schema_refs: schemaRefs
    },
    vector_json: null,
    score: relevance,
    rerank_score: relevance,
    embedding_model: "test"
  };
}
