import { Parser } from "node-sql-parser";
import type { SqlDialect } from "./sqlGenerator";

export interface SchemaObjectAllowlistEntry {
  schema_name: string;
  object_name: string;
  [key: string]: unknown;
}

export interface ParsedRef {
  schema: string;
  object: string;
  raw: string;
}

export interface ValidateAstReadOnlyResult {
  ok: boolean;
  errors: string[];
  refs: ParsedRef[];
}

const parser = new Parser();

function normalizeIdentifier(identifier: unknown): string {
  return String(identifier || "")
    .replace(/^"+|"+$/g, "")
    .replace(/^\[+|\]+$/g, "")
    .trim()
    .toLowerCase();
}

function parserDialectsFor(dialect: SqlDialect | string): string[] {
  if (dialect === "mssql") {
    return ["TransactSQL", "MSSQL", "TSQL"];
  }
  return ["Postgresql"];
}

interface ParseAstFailure {
  error: string;
}

function parseAst(sql: string, dialect: SqlDialect | string = "postgres"): unknown | ParseAstFailure {
  let lastError: Error | null = null;
  for (const parserDialect of parserDialectsFor(dialect)) {
    try {
      return parser.astify(sql, { database: parserDialect });
    } catch (err) {
      lastError = err as Error;
    }
  }
  return {
    error: `SQL parse error: ${lastError ? lastError.message : "unknown parser error"}`
  };
}

function validateSingleSelect(ast: unknown): { ok: boolean; errors: string[] } {
  const statements = Array.isArray(ast) ? ast : [ast];
  if (statements.length !== 1) {
    return { ok: false, errors: ["Only one SQL statement is allowed"] };
  }

  const statement = statements[0] as { type?: string } | null;
  if (!statement || statement.type !== "select") {
    return { ok: false, errors: ["Only SELECT queries are allowed"] };
  }

  return { ok: true, errors: [] };
}

function extractRefsFromTableList(sql: string, dialect: SqlDialect | string = "postgres"): ParsedRef[] {
  let rawRefs: string[] = [];
  for (const parserDialect of parserDialectsFor(dialect)) {
    try {
      rawRefs = parser.tableList(sql, { database: parserDialect });
      break;
    } catch {
      rawRefs = [];
    }
  }

  return rawRefs
    .map((entry) => {
      const parts = String(entry).split("::");
      if (parts.length !== 3) {
        return null;
      }

      const [, schemaPart, objectPart] = parts;
      if (!objectPart) {
        return null;
      }

      const schema = normalizeIdentifier(schemaPart === "null" ? "public" : schemaPart);
      const object = normalizeIdentifier(objectPart);
      return { schema, object, raw: `${schema}.${object}` };
    })
    .filter((entry): entry is ParsedRef => entry !== null);
}

function validateAllowlistedObjects(
  sql: string,
  schemaObjects: SchemaObjectAllowlistEntry[] | unknown,
  dialect: SqlDialect | string = "postgres"
): ValidateAstReadOnlyResult {
  const refs = extractRefsFromTableList(sql, dialect);

  if (!Array.isArray(schemaObjects) || schemaObjects.length === 0) {
    return { ok: true, errors: [], refs };
  }

  const allowSet = new Set(
    schemaObjects.map((obj) => `${obj.schema_name.toLowerCase()}.${obj.object_name.toLowerCase()}`)
  );

  const unknown = refs.filter((ref) => !allowSet.has(`${ref.schema}.${ref.object}`));

  if (unknown.length > 0) {
    return {
      ok: false,
      errors: [`Unknown or non-allowlisted objects referenced: ${unknown.map((x) => x.raw).join(", ")}`],
      refs
    };
  }

  return {
    ok: true,
    errors: [],
    refs
  };
}

function extractRefsWithRegex(sql: string): ParsedRef[] {
  const refs: ParsedRef[] = [];
  const pattern = /\b(?:from|join)\s+([a-z0-9_\[\]."]+)/gi;
  let match: RegExpExecArray | null;

  while ((match = pattern.exec(sql)) !== null) {
    const normalized = normalizeObjectRef(match[1]);
    if (!normalized) {
      continue;
    }
    refs.push(normalized);
  }

  return refs;
}

function normalizeObjectRef(rawRef: unknown): ParsedRef | null {
  const cleaned = String(rawRef || "")
    .replace(/[;,]+$/g, "")
    .trim();
  if (!cleaned) {
    return null;
  }

  const parts = cleaned
    .split(".")
    .map((part) => normalizeIdentifier(part))
    .filter(Boolean);

  if (parts.length === 0) {
    return null;
  }
  if (parts.length === 1) {
    return { schema: "dbo", object: parts[0], raw: `dbo.${parts[0]}` };
  }

  const schema = parts[parts.length - 2];
  const object = parts[parts.length - 1];
  return { schema, object, raw: `${schema}.${object}` };
}

function validateMssqlReadOnlyFallback(
  sql: unknown,
  schemaObjects: SchemaObjectAllowlistEntry[] | unknown
): ValidateAstReadOnlyResult {
  const text = String(sql || "").trim();
  if (!/^\s*(select|with)\b/i.test(text)) {
    return { ok: false, errors: ["Only SELECT queries are allowed"], refs: [] };
  }

  const blockedKeywords = /\b(insert|update|delete|alter|drop|truncate|create|grant|revoke|merge|exec|execute)\b/i;
  if (blockedKeywords.test(text)) {
    return { ok: false, errors: ["Only read-only SELECT queries are allowed"], refs: [] };
  }

  const refs = extractRefsWithRegex(text);
  if (!Array.isArray(schemaObjects) || schemaObjects.length === 0) {
    return { ok: true, errors: [], refs };
  }

  const allowSet = new Set(
    schemaObjects.map((obj) => `${String(obj.schema_name).toLowerCase()}.${String(obj.object_name).toLowerCase()}`)
  );
  const unknown = refs.filter((ref) => !allowSet.has(`${ref.schema}.${ref.object}`));
  if (unknown.length > 0) {
    return {
      ok: false,
      errors: [`Unknown or non-allowlisted objects referenced: ${unknown.map((x) => x.raw).join(", ")}`],
      refs
    };
  }

  return { ok: true, errors: [], refs };
}

export function validateAstReadOnly(
  sql: string,
  schemaObjects: SchemaObjectAllowlistEntry[] | unknown,
  dialect: SqlDialect | string = "postgres"
): ValidateAstReadOnlyResult {
  const parsed = parseAst(sql, dialect);
  if ((parsed as ParseAstFailure).error) {
    if (dialect === "mssql") {
      return validateMssqlReadOnlyFallback(sql, schemaObjects);
    }
    return { ok: false, errors: [(parsed as ParseAstFailure).error], refs: [] };
  }

  const statementCheck = validateSingleSelect(parsed);
  if (!statementCheck.ok) {
    return { ok: false, errors: statementCheck.errors, refs: [] };
  }

  return validateAllowlistedObjects(sql, schemaObjects, dialect);
}
