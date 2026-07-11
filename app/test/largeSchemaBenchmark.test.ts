import "./helpers/setupEnv";
import { test } from "node:test";
import assert from "node:assert/strict";

process.env.DATABASE_URL = process.env.DATABASE_URL || "postgresql://test:test@localhost:5432/test";

import {
  formatLargeSchemaGateFailures,
  runLargeSchemaBenchmark
} from "../src/benchmark/largeSchemaBenchmark";

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
  assert.equal(result.gate_diagnostics.length, 8);
  assert.equal(result.gate_diagnostics.every((gate) => gate.passed), true);
  assert.deepEqual(result.scaling.map((item) => item.distractor_table_count), [100, 300, 1000]);
  assert.equal(result.scaling.every((item) => item.table_recall_at_15 >= 0.95), true);
  assert.equal(result.scaling.every((item) => item.join_path_accuracy === 1), true);
  assert.equal(result.scaling.every((item) => item.max_candidate_count <= 15), true);
  assert.equal(result.scaling.every((item) => item.p95_linking_latency_ms <= 250), true);
  assert.deepEqual(formatLargeSchemaGateFailures(result), []);
});

test("large-schema gate failures identify the pipeline stage and metric", async () => {
  const result = await runLargeSchemaBenchmark();
  const regressed = {
    ...result,
    gate_diagnostics: result.gate_diagnostics.map((gate, index) => (
      index === 0 ? { ...gate, actual: 0.8, passed: false } : gate
    ))
  };

  assert.deepEqual(formatLargeSchemaGateFailures(regressed), [
    "schema_linking.table_recall_at_15 failed: actual 0.8 must be >= 0.95"
  ]);
});
