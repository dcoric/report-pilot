import { test } from "node:test";
import assert from "node:assert/strict";

import { summarizeQueryQuality } from "../src/benchmark/queryQualityGates";

test("query quality gates pass within fallback and repair thresholds", () => {
  const summary = summarizeQueryQuality([
    ...Array.from({ length: 9 }, () => ({ provider: "openai", repair_count: 0, run_status: 200 })),
    { provider: "local-fallback", repair_count: 0, run_status: 200 },
    { provider: "openai", repair_count: 1, run_status: 200 },
    { provider: "openai", repair_count: 1, run_status: 200 },
    { provider: "openai", repair_count: 1, run_status: 200 },
    { provider: "openai", repair_count: 1, run_status: 200 },
    { provider: "openai", repair_count: 1, run_status: 400 }
  ]);

  assert.equal(summary.fallback_rate, 0.0714);
  assert.equal(summary.repair_success_rate, 0.8);
  assert.deepEqual(summary.gates, {
    fallback_rate_le_10pct: true,
    repair_success_rate_ge_80pct: true
  });
});

test("query quality gates fail excessive fallback and unsuccessful repair", () => {
  const summary = summarizeQueryQuality([
    { provider: "local-fallback", repair_count: 0, run_status: 200 },
    { provider: "local-fallback", repair_count: 1, run_status: 400 },
    { provider: "openai", repair_count: 1, run_status: 400 },
    { provider: "openai", repair_count: 1, run_status: 200 }
  ]);

  assert.equal(summary.fallback_rate, 0.5);
  assert.equal(summary.repair_success_rate, 0.3333);
  assert.equal(summary.gates.fallback_rate_le_10pct, false);
  assert.equal(summary.gates.repair_success_rate_ge_80pct, false);
});

test("query quality repair gate is neutral when no repairs were attempted", () => {
  const summary = summarizeQueryQuality([
    { provider: "openai", repair_count: 0, run_status: 200 }
  ]);

  assert.equal(summary.repair_success_rate, null);
  assert.equal(summary.gates.repair_success_rate_ge_80pct, true);
});
