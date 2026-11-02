import { test } from "node:test";
import assert from "node:assert/strict";

import { extractForbiddenColumnsFromRagNotes,
  validateSqlAgainstForbiddenColumns,
  withoutForbiddenColumns } from "../src/services/columnPolicyService";

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

const blockedPassword = [{ schema: "dbo", object: "Users", column: "Password" }];
const usersAndOrders = [{ schema: "dbo", object: "users" }, { schema: "dbo", object: "orders" }];

test("validateSqlAgainstForbiddenColumns blocks SELECT * on a table with a forbidden column", () => {
  for (const sql of [
    "SELECT * FROM dbo.Users",
    "SELECT TOP 10 * FROM dbo.Users",
    "SELECT TOP (10) * FROM dbo.Users",
    "SELECT DISTINCT * FROM dbo.Users",
    "SELECT u.* FROM dbo.Users u",
    "SELECT [u].* FROM dbo.Users u",
    "SELECT 1 AS a, * FROM dbo.Users",
    "SELECT x.Id FROM (SELECT * FROM dbo.Users) x"
  ]) {
    assert.equal(validateSqlAgainstForbiddenColumns(sql, blockedPassword, [{ schema: "dbo", object: "users" }], "mssql").ok, false, sql);
  }
});

test("validateSqlAgainstForbiddenColumns allows COUNT(*), multiplication and a star on other tables", () => {
  const usersOnly = [{ schema: "dbo", object: "users" }];
  for (const sql of ["SELECT COUNT(*) FROM dbo.Users", "SELECT Id * 2 AS d FROM dbo.Users"]) {
    assert.equal(validateSqlAgainstForbiddenColumns(sql, blockedPassword, usersOnly, "mssql").ok, true, sql);
  }
  assert.equal(
    validateSqlAgainstForbiddenColumns("SELECT * FROM dbo.Orders", blockedPassword, [{ schema: "dbo", object: "orders" }], "mssql").ok,
    true
  );
});

test("validateSqlAgainstForbiddenColumns blocks unqualified and aliased use in a join", () => {
  for (const sql of [
    "SELECT Password FROM dbo.Users u JOIN dbo.Orders o ON o.UserId = u.Id",
    "SELECT [Password] FROM dbo.Users u JOIN dbo.Orders o ON o.UserId = u.Id",
    "SELECT u.Password FROM dbo.Users u JOIN dbo.Orders o ON o.UserId = u.Id",
    "SELECT unknown_alias.Password FROM dbo.Users, dbo.Orders unknown_alias2",
    "SELECT o.Password FROM dbo.Orders o JOIN (SELECT u.Password FROM dbo.Users u) o2 ON 1 = 1"
  ]) {
    assert.equal(validateSqlAgainstForbiddenColumns(sql, blockedPassword, usersAndOrders, "mssql").ok, false, sql);
  }
});

test("validateSqlAgainstForbiddenColumns allows the same column name on another table in a join", () => {
  const result = validateSqlAgainstForbiddenColumns(
    "SELECT o.Password, dbo.Orders.Password FROM dbo.Users u JOIN dbo.Orders o ON o.UserId = u.Id",
    blockedPassword,
    usersAndOrders,
    "mssql"
  );
  assert.equal(result.ok, true);
});

test("withoutForbiddenColumns hides forbidden columns only on their own table", () => {
  const columns = [
    { schema_name: "dbo", object_name: "Users", column_name: "Password" },
    { schema_name: "dbo", object_name: "Users", column_name: "Id" },
    { schema_name: "dbo", object_name: "Orders", column_name: "Password" }
  ];
  assert.deepEqual(
    withoutForbiddenColumns(columns, blockedPassword).map((col) => `${col.object_name}.${col.column_name}`),
    ["Users.Id", "Orders.Password"]
  );
});

test("a word containing ban does not forbid the columns a note names", () => {
  const known = [{ schema_name: "public", object_name: "accounts", column_name: "name" }];
  const named = (content: string) => extractForbiddenColumnsFromRagNotes([{ title: "Accounts", content }], known);
  assert.deepEqual(named("Bank customers and urban branches are found through public.accounts.name."), []);
  assert.equal(named("We ban public.accounts.name.").length, 1);
  assert.equal(named("public.accounts.name is banned.").length, 1);
});
