const test = require("node:test");
const assert = require("node:assert/strict");

const {
  extractForbiddenColumnsFromRagNotes,
  validateSqlAgainstForbiddenColumns
} = require("../src/services/columnPolicyService");

const knownColumns = [
  { schema_name: "Sales", object_name: "vSalesPerson", column_name: "BusinessEntityID" },
  { schema_name: "Sales", object_name: "vSalesPerson", column_name: "OrderDate" },
  { schema_name: "Sales", object_name: "vSalesPerson", column_name: "SalesLastYear" },
  { schema_name: "Sales", object_name: "vSalesPersonSalesByFiscalYears", column_name: "SalesPersonID" },
  { schema_name: "Sales", object_name: "vSalesPersonSalesByFiscalYears", column_name: "2014" }
];

test("extractForbiddenColumnsFromRagNotes parses explicit three-part refs from negative notes", () => {
  const notes = [
    {
      id: "n1",
      title: "Do not use deprecated columns",
      content: "Do not use Sales.vSalesPerson.OrderDate in reporting."
    }
  ];

  const result = extractForbiddenColumnsFromRagNotes(notes, knownColumns);
  assert.deepEqual(result, [
    {
      schema: "Sales",
      object: "vSalesPerson",
      column: "OrderDate",
      note_id: "n1"
    }
  ]);
});

test("extractForbiddenColumnsFromRagNotes ignores neutral notes", () => {
  const notes = [
    {
      id: "n2",
      title: "Helpful context",
      content: "Sales.vSalesPerson.OrderDate exists in legacy systems."
    }
  ];

  const result = extractForbiddenColumnsFromRagNotes(notes, knownColumns);
  assert.equal(result.length, 0);
});

test("validateSqlAgainstForbiddenColumns blocks qualified and aliased access", () => {
  const forbidden = [
    {
      schema: "Sales",
      object: "vSalesPerson",
      column: "OrderDate"
    }
  ];
  const refs = [{ schema: "sales", object: "vsalesperson" }];

  const qualified = validateSqlAgainstForbiddenColumns(
    "SELECT [OrderDate] FROM [Sales].[vSalesPerson];",
    forbidden,
    refs,
    "mssql"
  );
  assert.equal(qualified.ok, false);
  assert.match(qualified.errors[0], /Forbidden column referenced/i);

  const aliased = validateSqlAgainstForbiddenColumns(
    "SELECT sp.[OrderDate] FROM [Sales].[vSalesPerson] AS sp;",
    forbidden,
    refs,
    "mssql"
  );
  assert.equal(aliased.ok, false);
  assert.match(aliased.errors[0], /Forbidden column referenced/i);
});

test("validateSqlAgainstForbiddenColumns allows column name on different objects", () => {
  const forbidden = [
    {
      schema: "Sales",
      object: "vSalesPerson",
      column: "OrderDate"
    }
  ];
  const refs = [{ schema: "sales", object: "vsalespersonsalesbyfiscalyears" }];

  const result = validateSqlAgainstForbiddenColumns(
    "SELECT [OrderDate] FROM [Sales].[vSalesPersonSalesByFiscalYears];",
    forbidden,
    refs,
    "mssql"
  );

  assert.equal(result.ok, true);
});
