import "./helpers/setupEnv";
import { test } from "node:test";
import assert from "node:assert/strict";

process.env.DATABASE_URL = process.env.DATABASE_URL || "postgresql://test:test@localhost:5432/test";

import appDb = require("../src/lib/appDb");
import dbAdapterFactory = require("../src/adapters/dbAdapterFactory");
import * as xlsx from "xlsx";
import { __private, exportQueryResult } from "../src/services/exportService";

test("exportQueryResult writes a readable XLSX workbook in adapter column order", async () => {
  const originalQuery = appDb.query;
  const originalCreateDatabaseAdapter = dbAdapterFactory.createDatabaseAdapter;
  let queryNumber = 0;
  let adapterClosed = false;

  appDb.query = (async () => {
    queryNumber += 1;
    if (queryNumber === 1) {
      return {
        rowCount: 1,
        rows: [{
          id: "00000000-0000-4000-8000-000000000001",
          data_source_id: "00000000-0000-4000-8000-000000000111",
          question: "Quarterly sales",
          connection_ref: "postgresql://example.invalid/reporting",
          db_type: "postgres"
        }]
      };
    }
    if (queryNumber === 2) {
      return { rowCount: 1, rows: [{ generated_sql: "SELECT 2 AS second, 1 AS first" }] };
    }
    throw new Error(`Unexpected app database query #${queryNumber}`);
  }) as unknown as typeof appDb.query;

  (dbAdapterFactory as { createDatabaseAdapter: typeof dbAdapterFactory.createDatabaseAdapter }).createDatabaseAdapter = (() => ({
    async executeReadOnly() {
      return {
        columns: ["second", "first"],
        rows: [{ first: 1, second: 2 }],
        rowCount: 1,
        originalRowCount: 1,
        truncated: false,
        durationMs: 1
      };
    },
    async close() {
      adapterClosed = true;
    }
  })) as unknown as typeof dbAdapterFactory.createDatabaseAdapter;

  try {
    const exported = await exportQueryResult("00000000-0000-4000-8000-000000000001", "xlsx");

    assert.equal(exported.contentType, "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    assert.match(exported.filename, /^Quarterly_sales_.*\.xlsx$/);
    assert.ok(exported.buffer.length > 0);

    const workbook = xlsx.read(exported.buffer, { type: "buffer" });
    assert.deepEqual(workbook.SheetNames, ["Results"]);
    const resultsSheet = workbook.Sheets.Results;
    assert.ok(resultsSheet);
    assert.deepEqual(xlsx.utils.sheet_to_json(resultsSheet, { header: 1 }), [
      ["second", "first"],
      [2, 1]
    ]);
    assert.equal(adapterClosed, true);
  } finally {
    appDb.query = originalQuery;
    (dbAdapterFactory as { createDatabaseAdapter: typeof dbAdapterFactory.createDatabaseAdapter }).createDatabaseAdapter = originalCreateDatabaseAdapter;
  }
});

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

  const normalized = __private.normalizeJsonValue(value) as Record<string, unknown>;
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
  assert.equal((__private.normalizeParquetValue("2026-02-16", "TIMESTAMP_MILLIS") as Date).toISOString(), "2026-02-16T00:00:00.000Z");
  assert.equal(__private.normalizeParquetValue(123, "UTF8"), "123");
});
