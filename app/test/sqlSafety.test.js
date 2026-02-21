const test = require("node:test");
const assert = require("node:assert/strict");

const { validateAndNormalizeSql } = require("../src/services/sqlSafety");

test("postgres dialect enforces LIMIT", () => {
  const result = validateAndNormalizeSql("SELECT * FROM public.users", {
    maxRows: 25,
    dialect: "postgres"
  });

  assert.equal(result.ok, true);
  assert.match(result.sql, /\bLIMIT 25;$/i);
});

test("mssql dialect enforces TOP for simple SELECT", () => {
  const result = validateAndNormalizeSql("SELECT * FROM [Sales].[SalesOrderHeader]", {
    maxRows: 10,
    dialect: "mssql",
    schemaObjects: [{ schema_name: "Sales", object_name: "SalesOrderHeader" }]
  });

  assert.equal(result.ok, true);
  assert.match(result.sql, /^\s*SELECT TOP 10 \* FROM \[Sales\]\.\[SalesOrderHeader\];$/i);
});

test("mssql dialect keeps existing TOP", () => {
  const result = validateAndNormalizeSql("SELECT TOP 5 * FROM [Sales].[SalesOrderHeader]", {
    maxRows: 10,
    dialect: "mssql",
    schemaObjects: [{ schema_name: "Sales", object_name: "SalesOrderHeader" }]
  });

  assert.equal(result.ok, true);
  assert.match(result.sql, /^\s*SELECT TOP 5 \* FROM \[Sales\]\.\[SalesOrderHeader\];$/i);
});

test("mssql fallback validator blocks write statements", () => {
  const result = validateAndNormalizeSql("UPDATE Sales.SalesOrderHeader SET RevisionNumber = 2", {
    maxRows: 10,
    dialect: "mssql"
  });

  assert.equal(result.ok, false);
  assert.match(result.errors.join(" "), /read-only|select/i);
});
