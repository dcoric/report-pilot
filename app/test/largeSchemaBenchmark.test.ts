import "./helpers/setupEnv";
import { test } from "node:test";
import assert from "node:assert/strict";

process.env.DATABASE_URL = process.env.DATABASE_URL || "postgresql://test:test@localhost:5432/test";

import { runLargeSchemaBenchmark } from "../src/benchmark/largeSchemaBenchmark";

test("large-schema benchmark compares legacy caps with hierarchical linking", async () => {
  const result = await runLargeSchemaBenchmark();

  assert.ok(result.schema.table_count >= 300);
  assert.ok(result.schema.column_count >= 2400);
  assert.equal(result.hierarchical.table_recall_at_15, 1);
  assert.equal(result.hierarchical.join_path_accuracy, 1);
  assert.ok(result.hierarchical.table_recall_at_15 > result.legacy_global.table_recall_at_40);
  assert.ok(result.hierarchical.average_prompt_chars < result.legacy_global.average_prompt_chars);
  assert.equal(result.cases.find((item) => item.id === "ls003")?.hierarchical.expansion_status, "complete");
  assert.equal(result.cases.find((item) => item.id === "ls005")?.hierarchical.expansion_status, "ambiguous");
  assert.equal(result.release_gates.all_passed, true);
});
