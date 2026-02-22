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

function extractForbiddenColumnsFromRagNotes(notes, knownColumns) {
  const normalizedColumns = buildKnownColumnMaps(knownColumns);
  const dedupe = new Map();

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

function validateSqlAgainstForbiddenColumns(sql, forbiddenColumns, refs, dialect = "postgres") {
  if (!Array.isArray(forbiddenColumns) || forbiddenColumns.length === 0) {
    return { ok: true, errors: [] };
  }

  const sqlText = String(sql || "");
  const referencedObjects = new Set(
    (Array.isArray(refs) ? refs : []).map((ref) => `${normalizeIdentifier(ref.schema)}.${normalizeIdentifier(ref.object)}`)
  );
  const aliasesByObject = extractObjectAliases(sqlText);

  const errors = [];
  for (const blocked of forbiddenColumns) {
    const schema = normalizeIdentifier(blocked.schema);
    const object = normalizeIdentifier(blocked.object);
    const column = normalizeIdentifier(blocked.column);
    const objectKey = `${schema}.${object}`;

    if (referencedObjects.size > 0 && !referencedObjects.has(objectKey)) {
      continue;
    }

    const aliasSet = aliasesByObject.get(objectKey) || new Set();
    const hasQualified = sqlMentionsQualifiedColumn(sqlText, schema, object, column, aliasSet);

    // Only apply bare-column checks for single-object queries to reduce false positives.
    const hasBare =
      referencedObjects.size === 1 &&
      referencedObjects.has(objectKey) &&
      sqlMentionsColumnToken(sqlText, column);

    if (hasQualified || hasBare) {
      errors.push(`Forbidden column referenced: ${blocked.schema}.${blocked.object}.${blocked.column}`);
    }
  }

  return {
    ok: errors.length === 0,
    errors
  };
}

function containsNegativeKeyword(text) {
  const normalized = String(text || "").toLowerCase();
  return NEGATIVE_KEYWORDS.some((keyword) => normalized.includes(keyword));
}

function extractColumnRefs(text) {
  const refs = [];
  const content = String(text || "");

  // schema.object.column (supports bare, quoted, and bracketed identifiers)
  const threePart = /((?:\[[^\]]+\]|"[^"]+"|[a-z_][\w$]*)\s*\.\s*(?:\[[^\]]+\]|"[^"]+"|[a-z_][\w$]*)\s*\.\s*(?:\[[^\]]+\]|"[^"]+"|[a-z_][\w$]*))/gi;
  // object.column fallback
  const twoPart = /((?:\[[^\]]+\]|"[^"]+"|[a-z_][\w$]*)\s*\.\s*(?:\[[^\]]+\]|"[^"]+"|[a-z_][\w$]*))/gi;

  let match;
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

function resolveColumnRef(ref, knownColumns) {
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

function buildKnownColumnMaps(knownColumns) {
  const byFull = new Map();
  const byObjectColumn = new Map();

  for (const col of Array.isArray(knownColumns) ? knownColumns : []) {
    const schema = normalizeIdentifier(col.schema_name);
    const object = normalizeIdentifier(col.object_name);
    const column = normalizeIdentifier(col.column_name);
    if (!schema || !object || !column) {
      continue;
    }

    const normalized = {
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
    byObjectColumn.get(objectColumnKey).push(normalized);
  }

  return { byFull, byObjectColumn };
}

function splitIdentifierPath(value) {
  return String(value || "")
    .split(".")
    .map((part) => normalizeIdentifier(part))
    .filter(Boolean);
}

function normalizeIdentifier(identifier) {
  return String(identifier || "")
    .trim()
    .replace(/^\[|\]$/g, "")
    .replace(/^"|"$/g, "")
    .toLowerCase();
}

function escapeRegExp(value) {
  return String(value || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function identifierPattern(identifier) {
  const escaped = escapeRegExp(identifier);
  return `(?:\\[${escaped}\\]|"${escaped}"|${escaped})`;
}

function sqlMentionsQualifiedColumn(sql, schema, object, column, aliases) {
  const prefixes = [
    `${identifierPattern(schema)}\\s*\\.\\s*${identifierPattern(object)}`,
    identifierPattern(object),
    ...[...aliases].map((alias) => identifierPattern(alias))
  ];

  for (const prefix of prefixes) {
    const pattern = new RegExp(`(^|[^\\w])${prefix}\\s*\\.\\s*${identifierPattern(column)}([^\\w]|$)`, "i");
    if (pattern.test(sql)) {
      return true;
    }
  }
  return false;
}

function sqlMentionsColumnToken(sql, column) {
  const startsAlpha = /^[a-z_]/i.test(column);
  const bare = startsAlpha ? `|${escapeRegExp(column)}\\b` : "";
  const pattern = new RegExp(`(^|[^\\w])(?:\\[${escapeRegExp(column)}\\]|"${escapeRegExp(column)}"${bare})`, "i");
  return pattern.test(sql);
}

function extractObjectAliases(sql) {
  const aliasesByObject = new Map();
  const text = String(sql || "");
  const pattern = /\b(?:from|join)\s+([a-z0-9_\[\]."]+)(?:\s+(?:as\s+)?([a-z0-9_\[\]"]+))?/gi;
  const blockedAliasTokens = new Set(["on", "where", "join", "group", "order", "limit", "top"]);

  let match;
  while ((match = pattern.exec(text)) !== null) {
    const objectRef = normalizeObjectRef(match[1]);
    if (!objectRef) {
      continue;
    }
    const objectKey = `${objectRef.schema}.${objectRef.object}`;
    if (!aliasesByObject.has(objectKey)) {
      aliasesByObject.set(objectKey, new Set());
    }

    const aliasCandidate = normalizeIdentifier(match[2]);
    if (!aliasCandidate || blockedAliasTokens.has(aliasCandidate)) {
      continue;
    }
    aliasesByObject.get(objectKey).add(aliasCandidate);
  }

  return aliasesByObject;
}

function normalizeObjectRef(rawRef) {
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

module.exports = {
  extractForbiddenColumnsFromRagNotes,
  validateSqlAgainstForbiddenColumns,
  __private: {
    containsNegativeKeyword,
    extractColumnRefs,
    resolveColumnRef,
    extractObjectAliases,
    sqlMentionsColumnToken,
    sqlMentionsQualifiedColumn
  }
};
