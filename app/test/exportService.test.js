const test = require("node:test");
const assert = require("node:assert/strict");

process.env.DATABASE_URL = process.env.DATABASE_URL || "postgresql://test:test@localhost:5432/test";

const { __private } = require("../src/services/exportService");

test("getColumnOrder prefers adapter columns", () => {
  const actual = __private.getColumnOrder(["b", "a"], [{ a: 1, b: 2 }]);
  assert.deepEqual(actual, ["b", "a"]);
});

test("getColumnOrder falls back to first row keys", () => {
  const actual = __private.getColumnOrder([], [{ a: 1, b: 2 }]);
  assert.deepEqual(actual, ["a", "b"]);
});

test("normalizeJsonValue handles dates, bigint, buffer and nested values", () => {
  const now = new Date("2026-02-16T12:00:00.000Z");
  const value = {
    stamp: now,
    id: BigInt(42),
    payload: Buffer.from("ok", "utf-8"),
    nested: [1, Number.NaN, { ok: true }]
  };

  const normalized = __private.normalizeJsonValue(value);
  assert.equal(normalized.stamp, "2026-02-16T12:00:00.000Z");
  assert.equal(normalized.id, "42");
  assert.equal(normalized.payload, Buffer.from("ok", "utf-8").toString("base64"));
  assert.deepEqual(normalized.nested, [1, null, { ok: true }]);
});

test("normalizeRowForJson preserves requested column order", () => {
  const row = { b: "x", a: "y", c: "z" };
  const normalized = __private.normalizeRowForJson(row, ["a", "b"]);
  assert.deepEqual(Object.keys(normalized), ["a", "b", "c"]);
});

test("inferParquetType infers boolean, integer, double, date and utf8", () => {
  assert.equal(__private.inferParquetType([true, false]), "BOOLEAN");
  assert.equal(__private.inferParquetType([1, 2, 3]), "INT64");
  assert.equal(__private.inferParquetType([1.2, 2.4]), "DOUBLE");
  assert.equal(__private.inferParquetType(["2026-02-16T12:00:00.000Z", "2026-02-17T12:00:00.000Z"]), "TIMESTAMP_MILLIS");
  assert.equal(__private.inferParquetType(["32", "64"]), "UTF8");
  assert.equal(__private.inferParquetType(["a", "b"]), "UTF8");
});

test("normalizeParquetValue coerces values by parquet type", () => {
  assert.equal(__private.normalizeParquetValue("1", "INT64"), 1);
  assert.equal(__private.normalizeParquetValue("2.5", "DOUBLE"), 2.5);
  assert.equal(__private.normalizeParquetValue("true", "BOOLEAN"), true);
  assert.equal(__private.normalizeParquetValue("false", "BOOLEAN"), false);
  assert.equal(__private.normalizeParquetValue("2026-02-16", "TIMESTAMP_MILLIS").toISOString(), "2026-02-16T00:00:00.000Z");
  assert.equal(__private.normalizeParquetValue(123, "UTF8"), "123");
});
