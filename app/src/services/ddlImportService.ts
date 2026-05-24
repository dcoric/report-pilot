/**
 * Parses SSMS-generated DDL scripts into the same snapshot format
 * produced by mssqlAdapter.introspectSchema().
 */

interface DdlObject {
  schemaName: string;
  objectName: string;
  objectType: "table" | "view";
}

interface DdlColumn {
  schemaName: string;
  objectName: string;
  columnName: string;
  dataType: string;
  nullable: boolean;
  isPk: boolean;
  ordinalPosition: number;
}

interface DdlRelationship {
  fromSchema: string;
  fromObject: string;
  fromColumn: string;
  toSchema: string;
  toObject: string;
  toColumn: string;
  relationshipType: "fk";
}

interface DdlIndex {
  schemaName: string;
  objectName: string;
  indexName: string;
  columns: string[];
  isUnique: boolean;
}

export interface DdlSnapshot {
  objects: DdlObject[];
  columns: DdlColumn[];
  relationships: DdlRelationship[];
  indexes: DdlIndex[];
}

export function parseSchemaFromDdl(ddlText: unknown): DdlSnapshot {
  // Strip BOM, null bytes (residual UTF-16 if client didn't decode properly),
  // and normalize line endings
  const text = String(ddlText || "")
    .replace(/^﻿/, "")
    .replace(/\0/g, "")
    .replace(/\r\n/g, "\n");
  const objects: DdlObject[] = [];
  const columns: DdlColumn[] = [];
  const relationships: DdlRelationship[] = [];
  const indexes: DdlIndex[] = [];

  // Track which columns are PKs (populated by inline and out-of-line constraints)
  const pkSet = new Set<string>();

  // ── 1. Parse CREATE TABLE statements (balanced-paren extraction) ──
  const createTableHeaderRe =
    /CREATE\s+TABLE\s+(\[?[\w.]+\]?\.?\[?[\w.]+\]?)\s*\(/gi;

  let headerMatch: RegExpExecArray | null;
  while ((headerMatch = createTableHeaderRe.exec(text)) !== null) {
    const rawName = headerMatch[1];
    const bodyStart = headerMatch.index + headerMatch[0].length;
    const body = extractBalancedBody(text, bodyStart);
    if (body === null) continue;

    const { schema, name } = parseQualifiedName(rawName);

    objects.push({
      schemaName: schema,
      objectName: name,
      objectType: "table"
    });

    parseTableBody(schema, name, body, columns, pkSet, relationships);
  }

  // ── 2. Parse CREATE VIEW statements ───────────────────────────────
  const createViewRe =
    /CREATE\s+VIEW\s+(\[?[\w.]+\]?\.?\[?[\w.]+\]?)\s/gi;

  let match: RegExpExecArray | null;
  while ((match = createViewRe.exec(text)) !== null) {
    const { schema, name } = parseQualifiedName(match[1]);
    objects.push({
      schemaName: schema,
      objectName: name,
      objectType: "view"
    });
  }

  // ── 3. Parse standalone ALTER TABLE … ADD FOREIGN KEY ─────────────
  const alterFkRe =
    /ALTER\s+TABLE\s+(\[?[\w.]+\]?\.?\[?[\w.]+\]?)\s+(?:WITH\s+(?:NO)?CHECK\s+)?ADD\s+(?:CONSTRAINT\s+\[?\w+\]?\s+)?FOREIGN\s+KEY\s*\(([^)]+)\)\s*REFERENCES\s+(\[?[\w.]+\]?\.?\[?[\w.]+\]?)\s*\(([^)]+)\)/gi;

  while ((match = alterFkRe.exec(text)) !== null) {
    const from = parseQualifiedName(match[1]);
    const fromCols = splitColumnList(match[2]);
    const to = parseQualifiedName(match[3]);
    const toCols = splitColumnList(match[4]);

    for (let i = 0; i < fromCols.length; i++) {
      relationships.push({
        fromSchema: from.schema,
        fromObject: from.name,
        fromColumn: fromCols[i],
        toSchema: to.schema,
        toObject: to.name,
        toColumn: toCols[i] || fromCols[i],
        relationshipType: "fk"
      });
    }
  }

  // ── 4. Parse standalone ALTER TABLE … ADD PRIMARY KEY ──────────────
  const alterPkRe =
    /ALTER\s+TABLE\s+(\[?[\w.]+\]?\.?\[?[\w.]+\]?)\s+(?:WITH\s+(?:NO)?CHECK\s+)?ADD\s+(?:CONSTRAINT\s+\[?\w+\]?\s+)?PRIMARY\s+KEY\s+(?:CLUSTERED|NONCLUSTERED)?\s*\(([^)]+)\)/gi;

  while ((match = alterPkRe.exec(text)) !== null) {
    const tbl = parseQualifiedName(match[1]);
    const pkCols = splitColumnList(match[2]);
    for (const col of pkCols) {
      pkSet.add(`${tbl.schema}.${tbl.name}.${col}`);
    }
  }

  // ── 5. Parse CREATE INDEX statements ──────────────────────────────
  const createIndexRe =
    /CREATE\s+(UNIQUE\s+)?(?:CLUSTERED\s+|NONCLUSTERED\s+)?INDEX\s+(\[?\w+\]?)\s+ON\s+(\[?[\w.]+\]?\.?\[?[\w.]+\]?)\s*\(([^)]+)\)/gi;

  while ((match = createIndexRe.exec(text)) !== null) {
    const isUnique = Boolean(match[1]);
    const tbl = parseQualifiedName(match[3]);
    const idxCols = splitColumnList(match[4]);

    indexes.push({
      schemaName: tbl.schema,
      objectName: tbl.name,
      indexName: unquote(match[2]),
      columns: idxCols,
      isUnique
    });
  }

  // ── 6. Mark PK columns ────────────────────────────────────────────
  for (const col of columns) {
    if (pkSet.has(`${col.schemaName}.${col.objectName}.${col.columnName}`)) {
      col.isPk = true;
    }
  }

  return dedupeSnapshot({ objects, columns, relationships, indexes });
}

// ─── Helpers ──────────────────────────────────────────────────────────

/**
 * Starting right after an opening '(', extract everything up to the
 * matching closing ')' respecting nested parens.
 */
function extractBalancedBody(text: string, startIndex: number): string | null {
  let depth = 1;
  let i = startIndex;
  while (i < text.length && depth > 0) {
    if (text[i] === "(") depth++;
    else if (text[i] === ")") depth--;
    if (depth > 0) i++;
  }
  if (depth !== 0) return null;
  return text.slice(startIndex, i);
}

function parseTableBody(
  schema: string,
  tableName: string,
  body: string,
  columns: DdlColumn[],
  pkSet: Set<string>,
  relationships: DdlRelationship[]
): void {
  const lines = splitTableBody(body);
  let ordinal = 0;

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    // ── Inline PRIMARY KEY constraint ──
    if (/^\s*(?:CONSTRAINT\s+\[?\w+\]?\s+)?PRIMARY\s+KEY/i.test(trimmed)) {
      const pkMatch = trimmed.match(/PRIMARY\s+KEY\s+(?:CLUSTERED\s+|NONCLUSTERED\s+)?\(([^)]+)\)/i);
      if (pkMatch) {
        for (const col of splitColumnList(pkMatch[1])) {
          pkSet.add(`${schema}.${tableName}.${col}`);
        }
      }
      continue;
    }

    // ── Inline FOREIGN KEY constraint ──
    if (/^\s*(?:CONSTRAINT\s+\[?\w+\]?\s+)?FOREIGN\s+KEY/i.test(trimmed)) {
      const fkMatch = trimmed.match(
        /FOREIGN\s+KEY\s*\(([^)]+)\)\s*REFERENCES\s+(\[?[\w.]+\]?\.?\[?[\w.]+\]?)\s*\(([^)]+)\)/i
      );
      if (fkMatch) {
        const fromCols = splitColumnList(fkMatch[1]);
        const to = parseQualifiedName(fkMatch[2]);
        const toCols = splitColumnList(fkMatch[3]);
        for (let i = 0; i < fromCols.length; i++) {
          relationships.push({
            fromSchema: schema,
            fromObject: tableName,
            fromColumn: fromCols[i],
            toSchema: to.schema,
            toObject: to.name,
            toColumn: toCols[i] || fromCols[i],
            relationshipType: "fk"
          });
        }
      }
      continue;
    }

    // ── CHECK / UNIQUE / DEFAULT-only constraints ──
    if (/^\s*(?:CONSTRAINT\s+\[?\w+\]?\s+)?(?:CHECK|UNIQUE|DEFAULT)\b/i.test(trimmed)) {
      continue;
    }

    // ── Column definition ──
    const colMatch = trimmed.match(
      /^(\[[^\]]+\]|\w+)\s+((?:\[[^\]]+\]|\w+)(?:\s*\([^)]*\))?)/i
    );
    if (!colMatch) continue;

    ordinal++;
    const colName = unquote(colMatch[1]);
    const dataType = normalizeDataType(colMatch[2]);
    const hasNotNull = /\bNOT\s+NULL\b/i.test(trimmed);
    const isInlinePk = /\bPRIMARY\s+KEY\b/i.test(trimmed);

    if (isInlinePk) {
      pkSet.add(`${schema}.${tableName}.${colName}`);
    }

    columns.push({
      schemaName: schema,
      objectName: tableName,
      columnName: colName,
      dataType,
      nullable: isInlinePk ? false : !hasNotNull,
      isPk: false, // will be set in step 6
      ordinalPosition: ordinal
    });
  }
}

function splitTableBody(body: string): string[] {
  const lines: string[] = [];
  let current = "";
  let depth = 0;

  for (const char of body) {
    if (char === "(") depth++;
    if (char === ")") depth--;
    if (char === "," && depth === 0) {
      lines.push(current);
      current = "";
    } else {
      current += char;
    }
  }
  if (current.trim()) {
    lines.push(current);
  }
  return lines;
}

function parseQualifiedName(raw: unknown): { schema: string; name: string } {
  const cleaned = String(raw || "").trim();
  // Handle [schema].[name] or schema.name
  const parts = cleaned.split(".");
  if (parts.length >= 2) {
    return {
      schema: unquote(parts[parts.length - 2]),
      name: unquote(parts[parts.length - 1])
    };
  }
  return { schema: "dbo", name: unquote(parts[0]) };
}

function unquote(s: unknown): string {
  return String(s || "")
    .trim()
    .replace(/^\[/, "")
    .replace(/\]$/, "");
}

function normalizeDataType(raw: unknown): string {
  return String(raw || "")
    .trim()
    .replace(/\[([^\]]+)\]/g, "$1")
    .replace(/\s+/g, " ")
    .toLowerCase();
}

function dedupeSnapshot(snapshot: DdlSnapshot): DdlSnapshot {
  const objects: DdlObject[] = [];
  const columns: DdlColumn[] = [];
  const relationships: DdlRelationship[] = [];
  const indexes: DdlIndex[] = [];

  const objectKeys = new Set<string>();
  for (const object of snapshot.objects || []) {
    const key = `${String(object.schemaName || "").toLowerCase()}.${String(object.objectName || "").toLowerCase()}`;
    if (objectKeys.has(key)) continue;
    objectKeys.add(key);
    objects.push(object);
  }

  const columnKeys = new Set<string>();
  for (const column of snapshot.columns || []) {
    const key = [
      String(column.schemaName || "").toLowerCase(),
      String(column.objectName || "").toLowerCase(),
      String(column.columnName || "").toLowerCase()
    ].join(".");
    if (columnKeys.has(key)) continue;
    columnKeys.add(key);
    columns.push(column);
  }

  const relationshipKeys = new Set<string>();
  for (const relationship of snapshot.relationships || []) {
    const key = [
      String(relationship.fromSchema || "").toLowerCase(),
      String(relationship.fromObject || "").toLowerCase(),
      String(relationship.fromColumn || "").toLowerCase(),
      String(relationship.toSchema || "").toLowerCase(),
      String(relationship.toObject || "").toLowerCase(),
      String(relationship.toColumn || "").toLowerCase(),
      String(relationship.relationshipType || "").toLowerCase()
    ].join("|");
    if (relationshipKeys.has(key)) continue;
    relationshipKeys.add(key);
    relationships.push(relationship);
  }

  const indexKeys = new Set<string>();
  for (const index of snapshot.indexes || []) {
    const key = [
      String(index.schemaName || "").toLowerCase(),
      String(index.objectName || "").toLowerCase(),
      String(index.indexName || "").toLowerCase()
    ].join("|");
    if (indexKeys.has(key)) continue;
    indexKeys.add(key);
    indexes.push(index);
  }

  return { objects, columns, relationships, indexes };
}

function splitColumnList(raw: unknown): string[] {
  return String(raw || "")
    .split(",")
    .map((s) => {
      // Remove ASC/DESC suffixes
      return unquote(s.trim().replace(/\s+(ASC|DESC)\s*$/i, ""));
    })
    .filter(Boolean);
}
