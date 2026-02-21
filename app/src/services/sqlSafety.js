const { validateAstReadOnly } = require("./sqlAstValidator");

function sanitizeGeneratedSql(raw) {
  let text = String(raw || "").trim();
  if (!text) {
    return "";
  }

  const fencedMatch = text.match(/```(?:sql)?\s*([\s\S]*?)```/i);
  if (fencedMatch && fencedMatch[1]) {
    text = fencedMatch[1].trim();
  }

  // If model returns explanation + SQL, keep from first SELECT/WITH onward.
  const startMatch = text.match(/\b(select|with)\b/i);
  if (startMatch && startMatch.index > 0) {
    text = text.slice(startMatch.index).trim();
  }

  return text;
}

function stripTrailingSemicolon(sql) {
  return sql.replace(/;\s*$/, "").trim();
}

function hasMultipleStatements(sql) {
  const trimmed = sql.trim();
  const withoutTrailing = trimmed.replace(/;\s*$/, "");
  return withoutTrailing.includes(";");
}

function hasLimitClause(sql) {
  return /\blimit\s+\d+\b/i.test(sql);
}

function hasTopClause(sql) {
  return /^\s*select\s+(?:distinct\s+)?top\s+\(?\d+\)?\b/i.test(sql);
}

function splitTopLevelCsv(selectPart) {
  const items = [];
  let current = "";
  let depth = 0;
  for (let i = 0; i < selectPart.length; i += 1) {
    const ch = selectPart[i];
    if (ch === "(") {
      depth += 1;
      current += ch;
      continue;
    }
    if (ch === ")") {
      depth = Math.max(0, depth - 1);
      current += ch;
      continue;
    }
    if (ch === "," && depth === 0) {
      if (current.trim()) {
        items.push(current.trim());
      }
      current = "";
      continue;
    }
    current += ch;
  }
  if (current.trim()) {
    items.push(current.trim());
  }
  return items;
}

function isSingleRowAggregateQuery(sql) {
  const text = String(sql || "").trim();
  if (!text) {
    return false;
  }

  // UNION-like constructs can return multiple sets.
  if (/\b(union|intersect|except)\b/i.test(text)) {
    return false;
  }

  // GROUP BY implies potentially many output rows.
  if (/\bgroup\s+by\b/i.test(text)) {
    return false;
  }

  // SELECT literal/constant style query without FROM is single row.
  if (!/\bfrom\b/i.test(text)) {
    return true;
  }

  const normalized = text.replace(/\s+/g, " ");
  const selectMatch = normalized.match(/^\s*select\s+(.+?)\s+from\s+/i);
  if (!selectMatch || !selectMatch[1]) {
    return false;
  }

  const expressions = splitTopLevelCsv(selectMatch[1]);
  if (expressions.length === 0) {
    return false;
  }

  // Window functions can still produce many rows.
  const hasWindow = expressions.some((expr) => /\bover\s*\(/i.test(expr));
  if (hasWindow) {
    return false;
  }

  // Treat aggregate-only projection as singleton result.
  const AGGREGATE_FN =
    /\b(count|sum|avg|min|max|bool_and|bool_or|array_agg|string_agg|json_agg|jsonb_agg)\s*\(/i;
  return expressions.every((expr) => AGGREGATE_FN.test(expr));
}

function stripTrailingLimit(sql) {
  const noSemi = stripTrailingSemicolon(sql);
  const withoutLimit = noSemi.replace(/\s+limit\s+\d+\s*$/i, "").trim();
  return `${withoutLimit};`;
}

function ensureLimit(sql, maxRows, dialect = "postgres") {
  if (isSingleRowAggregateQuery(sql)) {
    // Aggregate singleton queries (COUNT/SUM/etc.) should not carry LIMIT.
    if (dialect === "postgres") {
      return stripTrailingLimit(sql);
    }
    return `${stripTrailingSemicolon(sql)};`;
  }

  if (dialect === "mssql") {
    if (hasTopClause(sql)) {
      return `${stripTrailingSemicolon(sql)};`;
    }

    if (/^\s*select\b/i.test(sql)) {
      const baseSql = stripTrailingSemicolon(sql);
      const withTop = /^\s*select\s+distinct\b/i.test(baseSql)
        ? baseSql.replace(/^\s*select\s+distinct\b/i, `SELECT DISTINCT TOP ${Number(maxRows)}`)
        : baseSql.replace(/^\s*select\b/i, `SELECT TOP ${Number(maxRows)}`);
      return `${withTop};`;
    }

    // CTE + SELECT and other complex forms are kept as-is; row slicing is still enforced in adapter output.
    return `${stripTrailingSemicolon(sql)};`;
  }

  if (hasLimitClause(sql)) {
    return sql;
  }
  return `${stripTrailingSemicolon(sql)} LIMIT ${Number(maxRows)};`;
}

function validateAndNormalizeSql(rawSql, opts = {}) {
  const maxRows = Number(opts.maxRows || 1000);
  const schemaObjects = Array.isArray(opts.schemaObjects) ? opts.schemaObjects : [];
  const dialect = String(opts.dialect || "postgres").toLowerCase();

  let sql = sanitizeGeneratedSql(rawSql);
  if (!sql) {
    return { ok: false, sql: "", errors: ["Generated SQL is empty"], refs: [] };
  }

  if (hasMultipleStatements(sql)) {
    return {
      ok: false,
      sql,
      errors: ["Multiple SQL statements are not allowed"],
      refs: []
    };
  }

  sql = ensureLimit(sql, maxRows, dialect);

  const refsCheck = validateAstReadOnly(sql, schemaObjects, dialect);
  if (!refsCheck.ok) {
    return { ok: false, sql, errors: refsCheck.errors, refs: refsCheck.refs };
  }

  return { ok: true, sql, errors: [], refs: refsCheck.refs };
}

module.exports = {
  validateAndNormalizeSql,
  sanitizeGeneratedSql
};
