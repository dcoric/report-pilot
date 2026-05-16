// AUTH-007: pure unit tests for the preset validator. No DB / HTTP.

process.env.DATABASE_URL = process.env.DATABASE_URL || "postgresql://test:test@localhost:5432/test";

const { test } = require("node:test");
const assert = require("node:assert/strict");

const service = require("../src/services/promptPresetService");

test("validatePreset accepts a well-formed body and defaults optional fields", () => {
  const res = service.validatePreset({ title: "Revenue YoY", prompt_text: "Show revenue YoY by region" });
  assert.equal(res.ok, true);
  assert.equal(res.value.visibility, "private");
  assert.deepEqual(res.value.tags, []);
  assert.equal(res.value.data_source_id, null);
});

test("validatePreset rejects missing title / prompt_text on create", () => {
  const noTitle = service.validatePreset({ prompt_text: "Show revenue" });
  assert.equal(noTitle.ok, false);
  assert.equal(noTitle.code, "invalid_title");

  const noPrompt = service.validatePreset({ title: "x" });
  assert.equal(noPrompt.ok, false);
  assert.equal(noPrompt.code, "invalid_prompt_text");
});

test("validatePreset allows missing title in partial mode", () => {
  const res = service.validatePreset({ visibility: "shared" }, { partial: true });
  assert.equal(res.ok, true);
  assert.equal(res.value.visibility, "shared");
  // No title in the partial value: caller is expected to merge with existing.
  assert.equal(res.value.title, undefined);
});

test("validatePreset rejects an out-of-range tag length", () => {
  const longTag = "x".repeat(80);
  const res = service.validatePreset({
    title: "x", prompt_text: "y", tags: [longTag]
  });
  assert.equal(res.ok, false);
  assert.equal(res.code, "invalid_tags");
});

test("validatePreset deduplicates tags case-insensitively while preserving original casing", () => {
  const res = service.validatePreset({
    title: "x", prompt_text: "y", tags: ["Finance", "finance", "  Risk  "]
  });
  assert.equal(res.ok, true);
  assert.deepEqual(res.value.tags, ["Finance", "Risk"]);
});

test("validatePreset rejects an invalid visibility", () => {
  const res = service.validatePreset({
    title: "x", prompt_text: "y", visibility: "public"
  });
  assert.equal(res.ok, false);
  assert.equal(res.code, "invalid_visibility");
});

test("validatePreset rejects an oversized prompt", () => {
  const huge = "x".repeat(9 * 1024);
  const res = service.validatePreset({ title: "x", prompt_text: huge });
  assert.equal(res.ok, false);
  assert.equal(res.code, "invalid_prompt_text");
});

test("validatePreset rejects a malformed data_source_id", () => {
  const res = service.validatePreset({
    title: "x", prompt_text: "y", data_source_id: "not-a-uuid"
  });
  assert.equal(res.ok, false);
  assert.equal(res.code, "invalid_data_source_id");
});
