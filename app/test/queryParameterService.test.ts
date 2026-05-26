import { test } from "node:test";
import assert from "node:assert/strict";

import { extractPlaceholders,
  buildParameterSchemaFromPlaceholders } from "../src/services/queryParameterParser";
import { validateParameterSchema,
  validateParameterValues,
  substitutePlaceholdersForValidation } from "../src/services/queryParameterService";

test("extractPlaceholders ignores string literals and postgres casts", () => {
  const sql = `
    SELECT *
    FROM revenue
    WHERE country = :country
      AND note <> ':ignored'
      AND sold_at::date >= :start_date
      AND region = :country
  `;

  assert.deepEqual(extractPlaceholders(sql), ["country", "start_date"]);
});

test("buildParameterSchemaFromPlaceholders preserves matching schema entries", () => {
  const schema = buildParameterSchemaFromPlaceholders(["start_date", "country"], [
    { name: "start_date", type: "date", required: false, default: "2026-01-01", allowed_values: null },
    { name: "unused", type: "text", required: true, default: null, allowed_values: null }
  ]);

  assert.deepEqual(schema, [
    { name: "start_date", type: "date", required: false, default: "2026-01-01", allowed_values: null },
    { name: "country", type: "text", required: true, default: null, allowed_values: null }
  ]);
});

test("validateParameterSchema normalizes defaults and allowed values", () => {
  const result = validateParameterSchema([
    {
      name: "country",
      type: "text",
      required: false,
      default: "US",
      allowed_values: ["US", "CA", "US"]
    },
    {
      name: "start_date",
      type: "date",
      default: "2026-01-01"
    }
  ]);

  assert.equal(result.ok, true);
  assert.deepEqual(result.value, [
    {
      name: "country",
      type: "text",
      required: false,
      default: "US",
      allowed_values: ["US", "CA"]
    },
    {
      name: "start_date",
      type: "date",
      required: true,
      default: "2026-01-01",
      allowed_values: null
    }
  ]);
});

test("validateParameterValues coerces and rejects invalid values", () => {
  const schema = [
    { name: "country", type: "text", required: true, default: null, allowed_values: ["US", "CA"] },
    { name: "limit", type: "integer", required: false, default: 10, allowed_values: null },
    { name: "include_deleted", type: "boolean", required: false, default: false, allowed_values: null }
  ];

  const success = validateParameterValues(schema, {
    country: "CA",
    limit: "25",
    include_deleted: "true"
  });
  assert.equal(success.ok, true);
  assert.deepEqual(success.resolvedValues, {
    country: "CA",
    limit: 25,
    include_deleted: true
  });

  const failure = validateParameterValues(schema, {
    country: "BR",
    extra: "value"
  });
  assert.equal(failure.ok, false);
  assert.deepEqual(failure.errors, [
    { param: "country", message: "must be one of the allowed values" },
    { param: "extra", message: "is not defined in parameter_schema" }
  ]);
});

test("substitutePlaceholdersForValidation replaces placeholders outside literals", () => {
  const substituted = substitutePlaceholdersForValidation(
    "SELECT * FROM revenue WHERE country = :country AND sold_at >= :start_date AND note = ':country'",
    [
      { name: "country", type: "text", required: true, default: null, allowed_values: null },
      { name: "start_date", type: "date", required: true, default: null, allowed_values: null }
    ]
  );

  assert.equal(
    substituted,
    "SELECT * FROM revenue WHERE country = 'x' AND sold_at >= '1900-01-01' AND note = ':country'"
  );
});
