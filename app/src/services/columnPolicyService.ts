export interface ForbiddenColumn {
  schema: string;
  object: string;
  column: string;
  note_id?: string | null;
}

export interface KnownColumn {
  schema_name: string;
  object_name: string;
  column_name: string;
}

export interface ParsedRefInput {
  schema: string;
  object: string;
}

export interface ColumnPolicyValidationResult {
  ok: boolean;
  errors: string[];
}

const NEGATIVE_KEYWORDS = [
  "do not use",
  "don't use",
  "dont use",
  "must not use",
  "forbid",
  "forbidden",
  "avoid",
  "exclude",
  "not allowed",
  "disallow",
  "never use",
  "blocked",
  "ban"
];

interface ColumnRef {
  kind: "two_part" | "three_part";
  parts: string[];
}

interface KnownColumnMaps {
  byFull: Map<string, ForbiddenColumn>;
  byObjectColumn: Map<string, ForbiddenColumn[]>;
}

export function extractForbiddenColumnsFromRagNotes(
  notes: Array<{ id?: string | null; title?: string | null; content?: string | null }> | unknown,
  knownColumns: KnownColumn[] | unknown
): ForbiddenColumn[] {
  const normalizedColumns = buildKnownColumnMaps(knownColumns);
  const dedupe = new Map<string, ForbiddenColumn>();

  for (const note of Array.isArray(notes) ? notes : []) {
    const text = [note?.title, note?.content].filter(Boolean).join("\n");
    if (!containsNegativeKeyword(text)) {
      continue;
    }

    const refs = extractColumnRefs(text);
    for (const ref of refs) {
      const resolved = resolveColumnRef(ref, normalizedColumns);
      if (!resolved) {
        continue;
      }
      const key = `${resolved.schema}.${resolved.object}.${resolved.column}`;
      if (!dedupe.has(key)) {
        dedupe.set(key, {
          ...resolved,
          note_id: note?.id || null
        });
      }
    }
  }

  return [...dedupe.values()];
}

export function withoutForbiddenColumns<T extends KnownColumn>(columns: T[], forbiddenColumns: ForbiddenColumn[]): T[] {
  const forbidden = new Set(forbiddenColumns.map(
    (col) => `${normalizeIdentifier(col.schema)}.${normalizeIdentifier(col.object)}.${normalizeIdentifier(col.column)}`
  ));
  return columns.filter(
    (col) => !forbidden.has(`${normalizeIdentifier(col.schema_name)}.${normalizeIdentifier(col.object_name)}.${normalizeIdentifier(col.column_name)}`)
  );
}

export function validateSqlAgainstForbiddenColumns(
  sql: string,
  forbiddenColumns: ForbiddenColumn[] | unknown,
  refs: ParsedRefInput[] | unknown,
  _dialect: string = "postgres"
): ColumnPolicyValidationResult {
  if (!Array.isArray(forbiddenColumns) || forbiddenColumns.length === 0) {
    return { ok: true, errors: [] };
  }

  const sqlText = String(sql || "");
  const referencedObjects = new Set(
    (Array.isArray(refs) ? refs as ParsedRefInput[] : []).map((ref) => `${normalizeIdentifier(ref.schema)}.${normalizeIdentifier(ref.object)}`)
  );
  const aliasesByObject = extractObjectAliases(sqlText);
  const selectsAll = sqlSelectsAllColumns(sqlText);

  const errors: string[] = [];
  const reportedStarObjects = new Set<string>();
  for (const blocked of forbiddenColumns) {
    const schema = normalizeIdentifier(blocked.schema);
    const object = normalizeIdentifier(blocked.object);
    const column = normalizeIdentifier(blocked.column);
    const objectKey = `${schema}.${object}`;

    if (referencedObjects.size > 0 && !referencedObjects.has(objectKey)) {
      continue;
    }

    if (selectsAll && !reportedStarObjects.has(objectKey)) {
      reportedStarObjects.add(objectKey);
      errors.push(`SELECT * is not allowed on ${blocked.schema}.${blocked.object} because it has forbidden columns. List the columns instead.`);
    }

    const otherObjectQualifiers = qualifiersOfOtherObjects(objectKey, referencedObjects, aliasesByObject);
    if (sqlMentionsColumn(sqlText, column, otherObjectQualifiers)) {
      errors.push(`Forbidden column referenced: ${blocked.schema}.${blocked.object}.${blocked.column}`);
    }
  }

  return {
    ok: errors.length === 0,
    errors
  };
}

function containsNegativeKeyword(text: string): boolean {
  const normalized = String(text || "").toLowerCase();
  return NEGATIVE_KEYWORDS.some((keyword) => normalized.includes(keyword));
}

function extractColumnRefs(text: string): ColumnRef[] {
  const refs: ColumnRef[] = [];
  const content = String(text || "");

  // schema.object.column (supports bare, quoted, and bracketed identifiers)
  const threePart = /((?:\[[^\]]+\]|"[^"]+"|[a-z_][\w$]*)\s*\.\s*(?:\[[^\]]+\]|"[^"]+"|[a-z_][\w$]*)\s*\.\s*(?:\[[^\]]+\]|"[^"]+"|[a-z_][\w$]*))/gi;
  // object.column fallback
  const twoPart = /((?:\[[^\]]+\]|"[^"]+"|[a-z_][\w$]*)\s*\.\s*(?:\[[^\]]+\]|"[^"]+"|[a-z_][\w$]*))/gi;

  let match: RegExpExecArray | null;
  while ((match = threePart.exec(content)) !== null) {
    const parsed = splitIdentifierPath(match[1]);
    if (parsed.length === 3) {
      refs.push({ kind: "three_part", parts: parsed });
    }
  }

  while ((match = twoPart.exec(content)) !== null) {
    const parsed = splitIdentifierPath(match[1]);
    if (parsed.length !== 2) {
      continue;
    }
    refs.push({ kind: "two_part", parts: parsed });
  }

  return refs;
}

function resolveColumnRef(ref: ColumnRef, knownColumns: KnownColumnMaps): ForbiddenColumn | null {
  if (!ref || !Array.isArray(ref.parts)) {
    return null;
  }

  if (ref.kind === "three_part" && ref.parts.length === 3) {
    const [schema, object, column] = ref.parts.map(normalizeIdentifier);
    const key = `${schema}.${object}.${column}`;
    return knownColumns.byFull.get(key) || null;
  }

  if (ref.kind === "two_part" && ref.parts.length === 2) {
    const [object, column] = ref.parts.map(normalizeIdentifier);
    const key = `${object}.${column}`;
    const matches = knownColumns.byObjectColumn.get(key) || [];
    return matches.length === 1 ? matches[0] : null;
  }

  return null;
}

function buildKnownColumnMaps(knownColumns: KnownColumn[] | unknown): KnownColumnMaps {
  const byFull = new Map<string, ForbiddenColumn>();
  const byObjectColumn = new Map<string, ForbiddenColumn[]>();

  for (const col of Array.isArray(knownColumns) ? knownColumns : []) {
    const schema = normalizeIdentifier(col.schema_name);
    const object = normalizeIdentifier(col.object_name);
    const column = normalizeIdentifier(col.column_name);
    if (!schema || !object || !column) {
      continue;
    }

    const normalized: ForbiddenColumn = {
      schema: col.schema_name,
      object: col.object_name,
      column: col.column_name
    };

    const fullKey = `${schema}.${object}.${column}`;
    byFull.set(fullKey, normalized);

    const objectColumnKey = `${object}.${column}`;
    if (!byObjectColumn.has(objectColumnKey)) {
      byObjectColumn.set(objectColumnKey, []);
    }
    byObjectColumn.get(objectColumnKey)!.push(normalized);
  }

  return { byFull, byObjectColumn };
}

function splitIdentifierPath(value: unknown): string[] {
  return String(value || "")
    .split(".")
    .map((part) => normalizeIdentifier(part))
    .filter(Boolean);
}

function normalizeIdentifier(identifier: unknown): string {
  return String(identifier || "")
    .trim()
    .replace(/^\[|\]$/g, "")
    .replace(/^"|"$/g, "")
    .toLowerCase();
}

function escapeRegExp(value: unknown): string {
  return String(value || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// A star reads a forbidden column without naming it. COUNT(*) and multiplication do not match.
function sqlSelectsAllColumns(sql: string): boolean {
  const pattern = /\bselect\s+(?:(?:distinct|all)\s+)?(?:top\s*\(?\s*[@\w]+\s*\)?\s*(?:percent\s+)?(?:with\s+ties\s+)?)?\*|,\s*\*|[\w$\]"]\s*\.\s*\*/i;
  return pattern.test(sql);
}

function qualifiersOfOtherObjects(
  objectKey: string,
  referencedObjects: Set<string>,
  aliasesByObject: Map<string, Set<string>>
): Set<string> {
  const qualifiers = new Set<string>();
  for (const other of referencedObjects) {
    if (other === objectKey) {
      continue;
    }
    qualifiers.add(other.split(".").pop() as string);
    for (const alias of aliasesByObject.get(other) || []) {
      qualifiers.add(alias);
    }
  }
  qualifiers.delete(objectKey.split(".").pop() as string);
  for (const alias of aliasesByObject.get(objectKey) || []) {
    qualifiers.delete(alias);
  }
  return qualifiers;
}

// Fails closed: a mention counts unless it is qualified by another object in the query,
// so unqualified columns and unrecognized aliases are all treated as the forbidden column.
function sqlMentionsColumn(sql: string, column: string, otherObjectQualifiers: Set<string>): boolean {
  const name = escapeRegExp(column);
  const pattern = new RegExp(
    `(?:(\\[[^\\]]+\\]|"[^"]+"|[\\w$]+)\\s*\\.\\s*)?(?<![\\w$])(?:\\[${name}\\]|"${name}"|${name})(?![\\w$])`,
    "gi"
  );
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(sql)) !== null) {
    if (!match[1] || !otherObjectQualifiers.has(normalizeIdentifier(match[1]))) {
      return true;
    }
  }
  return false;
}

function extractObjectAliases(sql: string): Map<string, Set<string>> {
  const aliasesByObject = new Map<string, Set<string>>();
  const text = String(sql || "");
  const pattern = /\b(?:from|join)\s+([a-z0-9_\[\]."]+)(?:\s+(?:as\s+)?([a-z0-9_\[\]"]+))?/gi;
  const blockedAliasTokens = new Set(["on", "where", "join", "group", "order", "limit", "top"]);

  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text)) !== null) {
    const objectRef = normalizeObjectRef(match[1]);
    if (!objectRef) {
      continue;
    }
    const objectKey = `${objectRef.schema}.${objectRef.object}`;
    if (!aliasesByObject.has(objectKey)) {
      aliasesByObject.set(objectKey, new Set<string>());
    }

    const aliasCandidate = normalizeIdentifier(match[2]);
    if (!aliasCandidate || blockedAliasTokens.has(aliasCandidate)) {
      continue;
    }
    aliasesByObject.get(objectKey)!.add(aliasCandidate);
  }

  return aliasesByObject;
}

function normalizeObjectRef(rawRef: unknown): { schema: string; object: string } | null {
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

  if (parts.length < 2) {
    return null;
  }

  return {
    schema: parts[parts.length - 2],
    object: parts[parts.length - 1]
  };
}

export const __private = {
  containsNegativeKeyword,
  extractColumnRefs,
  resolveColumnRef,
  extractObjectAliases,
  sqlSelectsAllColumns,
  sqlMentionsColumn
};
