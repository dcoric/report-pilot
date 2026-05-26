import { test } from "node:test";
import assert from "node:assert/strict";

import { parseSchemaFromDdl } from "../src/services/ddlImportService";

test("parseSchemaFromDdl parses SSMS bracketed data types and keys", () => {
  const ddl = `
    CREATE TABLE [dbo].[Example](
      [Id] [int] NOT NULL,
      [Name] [varchar](50) NULL,
      [Amount] [decimal](8, 2) NULL,
      [Payload] [varbinary](max) NULL,
      CONSTRAINT [PK_Example] PRIMARY KEY NONCLUSTERED ([Id] ASC)
    ) ON [PRIMARY];
  `;

  const snapshot = parseSchemaFromDdl(ddl);

  assert.equal(snapshot.objects.length, 1);
  assert.equal(snapshot.columns.length, 4);

  assert.deepEqual(
    snapshot.columns.map((column) => ({
      name: column.columnName,
      type: column.dataType,
      nullable: column.nullable
    })),
    [
      { name: "Id", type: "int", nullable: false },
      { name: "Name", type: "varchar(50)", nullable: true },
      { name: "Amount", type: "decimal(8, 2)", nullable: true },
      { name: "Payload", type: "varbinary(max)", nullable: true }
    ]
  );

  const pkColumn = snapshot.columns.find((column) => column.columnName === "Id");
  assert.equal(pkColumn?.isPk, true);
});

test("parseSchemaFromDdl deduplicates repeated object definitions", () => {
  const ddl = `
    CREATE TABLE [dbo].[Example](
      [Id] [int] NOT NULL
    );

    CREATE TABLE [dbo].[Example](
      [Id] [int] NOT NULL
    );

    CREATE VIEW [dbo].[ExampleView] AS SELECT 1 AS [Id];
    CREATE VIEW [dbo].[ExampleView] AS SELECT 1 AS [Id];
  `;

  const snapshot = parseSchemaFromDdl(ddl);

  assert.equal(snapshot.objects.length, 2);
  assert.equal(snapshot.columns.length, 1);
});
