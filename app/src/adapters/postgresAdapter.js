const { Pool } = require("pg");
const { validateAstReadOnly } = require("../services/sqlAstValidator");

class PostgresAdapter {
  constructor(connectionString) {
    this.connectionString = connectionString;
    this.pool = new Pool({ connectionString });
  }

  type = "postgres";

  dialect() {
    return "postgres";
  }

  async close() {
    await this.pool.end();
  }

  async testConnection() {
    await this.pool.query("SELECT 1");
  }

  async introspectSchema() {
    const tablesSql = `
      SELECT
        t.table_schema,
        t.table_name,
        t.table_type
      FROM information_schema.tables t
      WHERE t.table_schema NOT IN ('pg_catalog', 'information_schema')
      ORDER BY t.table_schema, t.table_name;
    `;

    const columnsSql = `
      SELECT
        c.table_schema,
        c.table_name,
        c.column_name,
        c.data_type,
        c.is_nullable,
        c.ordinal_position
      FROM information_schema.columns c
      WHERE c.table_schema NOT IN ('pg_catalog', 'information_schema')
      ORDER BY c.table_schema, c.table_name, c.ordinal_position;
    `;

    const pkSql = `
      SELECT
        tc.table_schema,
        tc.table_name,
        kcu.column_name
      FROM information_schema.table_constraints tc
      JOIN information_schema.key_column_usage kcu
        ON tc.constraint_name = kcu.constraint_name
       AND tc.table_schema = kcu.table_schema
      WHERE tc.constraint_type = 'PRIMARY KEY'
        AND tc.table_schema NOT IN ('pg_catalog', 'information_schema');
    `;

    const fkSql = `
      SELECT
        tc.table_schema AS from_schema,
        tc.table_name AS from_table,
        kcu.column_name AS from_column,
        ccu.table_schema AS to_schema,
        ccu.table_name AS to_table,
        ccu.column_name AS to_column
      FROM information_schema.table_constraints tc
      JOIN information_schema.key_column_usage kcu
        ON tc.constraint_name = kcu.constraint_name
       AND tc.table_schema = kcu.table_schema
      JOIN information_schema.constraint_column_usage ccu
        ON ccu.constraint_name = tc.constraint_name
       AND ccu.table_schema = tc.table_schema
      WHERE tc.constraint_type = 'FOREIGN KEY'
        AND tc.table_schema NOT IN ('pg_catalog', 'information_schema');
    `;

    const indexesSql = `
      SELECT
        schemaname,
        tablename,
        indexname,
        indexdef
      FROM pg_catalog.pg_indexes
      WHERE schemaname NOT IN ('pg_catalog', 'information_schema')
      ORDER BY schemaname, tablename, indexname;
    `;

    const [tablesResult, columnsResult, pkResult, fkResult, indexesResult] = await Promise.all([
      this.pool.query(tablesSql),
      this.pool.query(columnsSql),
      this.pool.query(pkSql),
      this.pool.query(fkSql),
      this.pool.query(indexesSql)
    ]);

    const pkSet = new Set(
      pkResult.rows.map((row) => `${row.table_schema}.${row.table_name}.${row.column_name}`)
    );

    const objects = tablesResult.rows.map((row) => ({
      schemaName: row.table_schema,
      objectName: row.table_name,
      objectType: row.table_type === "VIEW" ? "view" : "table"
    }));

    const columns = columnsResult.rows.map((row) => ({
      schemaName: row.table_schema,
      objectName: row.table_name,
      columnName: row.column_name,
      dataType: row.data_type,
      nullable: row.is_nullable === "YES",
      isPk: pkSet.has(`${row.table_schema}.${row.table_name}.${row.column_name}`),
      ordinalPosition: row.ordinal_position
    }));

    const relationships = fkResult.rows.map((row) => ({
      fromSchema: row.from_schema,
      fromObject: row.from_table,
      fromColumn: row.from_column,
      toSchema: row.to_schema,
      toObject: row.to_table,
      toColumn: row.to_column,
      relationshipType: "fk"
    }));

    const indexes = indexesResult.rows.map((row) => ({
      schemaName: row.schemaname,
      objectName: row.tablename,
      indexName: row.indexname,
      columns: parseIndexColumns(row.indexdef),
      isUnique: row.indexdef.toLowerCase().includes(" unique ")
    }));

    return { objects, columns, relationships, indexes };
  }

  async validateSql(sql) {
    return validateAstReadOnly(sql, [], this.dialect());
  }

  async explain(sql) {
    const result = await this.pool.query(`EXPLAIN (FORMAT JSON) ${sql}`);
    return result.rows;
  }

  async executeReadOnly(sql, opts = {}) {
    const timeoutMs = Number(opts.timeoutMs || 20000);
    const maxRows = Number(opts.maxRows || 1000);

    const startedAt = Date.now();
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(`SET LOCAL statement_timeout = ${Number.isFinite(timeoutMs) ? timeoutMs : 20000}`);
      const result = await client.query(sql);
      await client.query("COMMIT");

      const rows = Array.isArray(result.rows) ? result.rows : [];
      const columns = result.fields ? result.fields.map((field) => field.name) : [];
      const truncated = rows.length > maxRows;
      const slicedRows = truncated ? rows.slice(0, maxRows) : rows;
      const safeRows = slicedRows.map((row) => {
        const sanitized = {};
        for (const key of Object.keys(row)) {
          const val = row[key];
          if (val !== null && typeof val === "object" && !(val instanceof Date)) {
            sanitized[key] = formatPgObject(val);
          } else {
            sanitized[key] = val;
          }
        }
        return sanitized;
      });

      return {
        columns,
        rows: safeRows,
        rowCount: safeRows.length,
        originalRowCount: rows.length,
        truncated,
        durationMs: Date.now() - startedAt
      };
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
  }

  quoteIdentifier(identifier) {
    return `"${String(identifier).replace(/"/g, "\"\"")}"`;
  }
}

function formatPgObject(val) {
  // pg interval objects: { years, months, days, hours, minutes, seconds, milliseconds }
  if ("days" in val || "hours" in val || "minutes" in val || "seconds" in val || "months" in val || "years" in val) {
    const parts = [];
    if (val.years) parts.push(`${val.years} year${val.years !== 1 ? "s" : ""}`);
    if (val.months) parts.push(`${val.months} month${val.months !== 1 ? "s" : ""}`);
    if (val.days) parts.push(`${val.days} day${val.days !== 1 ? "s" : ""}`);
    if (val.hours) parts.push(`${val.hours} hour${val.hours !== 1 ? "s" : ""}`);
    if (val.minutes) parts.push(`${val.minutes} minute${val.minutes !== 1 ? "s" : ""}`);
    if (val.seconds) parts.push(`${val.seconds} second${val.seconds !== 1 ? "s" : ""}`);
    return parts.length > 0 ? parts.join(" ") : "0 seconds";
  }
  // Arrays
  if (Array.isArray(val)) {
    return JSON.stringify(val);
  }
  // Generic fallback: JSON representation
  return JSON.stringify(val);
}

function parseIndexColumns(indexDef) {
  const match = indexDef.match(/\((.+)\)/);
  if (!match || !match[1]) {
    return [];
  }

  return match[1]
    .split(",")
    .map((part) => part.trim().replace(/"/g, ""))
    .filter(Boolean);
}

module.exports = {
  PostgresAdapter
};
