import { Pool, PoolClient, QueryResult as PgQueryResult, QueryResultRow as PgRow, FieldDef } from "pg";
import type {
  DbAdapter,
  DbDialect,
  ExecuteOptions,
  ParameterSchemaEntry,
  QueryResult,
  QueryResultRow,
  SchemaIntrospection,
  SqlValidationResult
} from "./types";

interface PgTableRow extends PgRow {
  table_schema: string;
  table_name: string;
  table_type: string;
}

interface PgColumnRow extends PgRow {
  table_schema: string;
  table_name: string;
  column_name: string;
  data_type: string;
  is_nullable: string;
  ordinal_position: number;
}

interface PgPrimaryKeyRow extends PgRow {
  table_schema: string;
  table_name: string;
  column_name: string;
}

interface PgForeignKeyRow extends PgRow {
  from_schema: string;
  from_table: string;
  from_column: string;
  to_schema: string;
  to_table: string;
  to_column: string;
}

interface PgIndexRow extends PgRow {
  schemaname: string;
  tablename: string;
  indexname: string;
  indexdef: string;
}

const { validateAstReadOnly } = require("../services/sqlAstValidator");
const { replaceNamedPlaceholders } = require("../services/queryParameterParser");

class PostgresAdapter implements DbAdapter {
  public readonly type: "postgres" = "postgres";
  public readonly connectionString: string;
  public readonly pool: Pool;

  constructor(connectionString: string) {
    this.connectionString = connectionString;
    this.pool = new Pool({ connectionString });
  }

  dialect(): DbDialect {
    return "postgres";
  }

  async close(): Promise<void> {
    await this.pool.end();
  }

  async testConnection(): Promise<void> {
    await this.pool.query("SELECT 1");
  }

  async introspectSchema(): Promise<SchemaIntrospection> {
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
      this.pool.query<PgTableRow>(tablesSql),
      this.pool.query<PgColumnRow>(columnsSql),
      this.pool.query<PgPrimaryKeyRow>(pkSql),
      this.pool.query<PgForeignKeyRow>(fkSql),
      this.pool.query<PgIndexRow>(indexesSql)
    ]);

    const pkSet = new Set(
      pkResult.rows.map((row) => `${row.table_schema}.${row.table_name}.${row.column_name}`)
    );

    const objects = tablesResult.rows.map((row) => ({
      schemaName: row.table_schema,
      objectName: row.table_name,
      objectType: (row.table_type === "VIEW" ? "view" : "table") as "table" | "view"
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
      relationshipType: "fk" as const
    }));

    const indexes = indexesResult.rows.map((row) => ({
      schemaName: row.schemaname,
      objectName: row.tablename,
      indexName: row.indexname,
      columns: parseIndexColumns(row.indexdef),
      isUnique: String(row.indexdef).toLowerCase().includes(" unique ")
    }));

    return { objects, columns, relationships, indexes };
  }

  async validateSql(sql: string): Promise<SqlValidationResult> {
    return validateAstReadOnly(sql, [], this.dialect());
  }

  async explain(sql: string): Promise<unknown[]> {
    const result = await this.pool.query(`EXPLAIN (FORMAT JSON) ${sql}`);
    return result.rows;
  }

  async execute(sql: string, params: unknown[] = []): Promise<QueryResult> {
    return this.executeWithReadOnlyTransaction(
      () => ({ text: sql, values: params }),
      {}
    );
  }

  async executeReadOnly(sql: string, opts: ExecuteOptions = {}): Promise<QueryResult> {
    return this.executeWithReadOnlyTransaction(() => sql, opts);
  }

  async executeParameterizedReadOnly(
    sql: string,
    paramValues: Record<string, unknown>,
    _paramSchema?: ParameterSchemaEntry[],
    opts: ExecuteOptions = {}
  ): Promise<QueryResult> {
    const { text, values } = transformPostgresNamedParameters(sql, paramValues);
    return this.executeWithReadOnlyTransaction(() => ({ text, values }), opts);
  }

  async executeWithReadOnlyTransaction(
    buildQuery: () => string | { text: string; values: unknown[] },
    opts: ExecuteOptions = {}
  ): Promise<QueryResult> {
    const timeoutMs = Number(opts.timeoutMs || 20000);
    const maxRows = Number(opts.maxRows || 1000);

    const startedAt = Date.now();
    const client: PoolClient = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        `SET LOCAL statement_timeout = ${Number.isFinite(timeoutMs) ? timeoutMs : 20000}`
      );
      const built = buildQuery();
      const result: PgQueryResult<QueryResultRow> =
        typeof built === "string"
          ? await client.query<QueryResultRow>(built)
          : await client.query<QueryResultRow, unknown[]>(built.text, built.values);
      await client.query("COMMIT");

      const rows = Array.isArray(result.rows) ? (result.rows as QueryResultRow[]) : [];
      const columns = result.fields
        ? (result.fields as FieldDef[]).map((field) => field.name)
        : [];
      const truncated = rows.length > maxRows;
      const slicedRows = truncated ? rows.slice(0, maxRows) : rows;
      const safeRows: QueryResultRow[] = slicedRows.map((row) => {
        const sanitized: QueryResultRow = {};
        for (const key of Object.keys(row)) {
          const val = (row as Record<string, unknown>)[key];
          if (val !== null && typeof val === "object" && !(val instanceof Date)) {
            sanitized[key] = formatPgObject(val as Record<string, unknown>);
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

  quoteIdentifier(identifier: string): string {
    return `"${String(identifier).replace(/"/g, "\"\"")}"`;
  }
}

function transformPostgresNamedParameters(
  sql: string,
  paramValues: Record<string, unknown> | null | undefined
): { text: string; values: unknown[] } {
  const values: unknown[] = [];
  const positions = new Map<string, number>();

  const text: string = replaceNamedPlaceholders(sql, (name: string) => {
    if (!Object.prototype.hasOwnProperty.call(paramValues || {}, name)) {
      throw new Error(`Missing parameter value for :${name}`);
    }

    if (!positions.has(name)) {
      positions.set(name, values.length + 1);
      values.push((paramValues as Record<string, unknown>)[name]);
    }

    return `$${positions.get(name)}`;
  });

  return { text, values };
}

function formatPgObject(val: Record<string, unknown> | unknown[]): string {
  // pg interval objects: { years, months, days, hours, minutes, seconds, milliseconds }
  if (!Array.isArray(val)) {
    const v = val as Record<string, number | undefined>;
    if (
      "days" in val ||
      "hours" in val ||
      "minutes" in val ||
      "seconds" in val ||
      "months" in val ||
      "years" in val
    ) {
      const parts: string[] = [];
      if (v.years) parts.push(`${v.years} year${v.years !== 1 ? "s" : ""}`);
      if (v.months) parts.push(`${v.months} month${v.months !== 1 ? "s" : ""}`);
      if (v.days) parts.push(`${v.days} day${v.days !== 1 ? "s" : ""}`);
      if (v.hours) parts.push(`${v.hours} hour${v.hours !== 1 ? "s" : ""}`);
      if (v.minutes) parts.push(`${v.minutes} minute${v.minutes !== 1 ? "s" : ""}`);
      if (v.seconds) parts.push(`${v.seconds} second${v.seconds !== 1 ? "s" : ""}`);
      return parts.length > 0 ? parts.join(" ") : "0 seconds";
    }
  }
  // Arrays
  if (Array.isArray(val)) {
    return JSON.stringify(val);
  }
  // Generic fallback: JSON representation
  return JSON.stringify(val);
}

function parseIndexColumns(indexDef: string): string[] {
  const match = String(indexDef).match(/\((.+)\)/);
  if (!match || !match[1]) {
    return [];
  }

  return match[1]
    .split(",")
    .map((part) => part.trim().replace(/"/g, ""))
    .filter(Boolean);
}

export { PostgresAdapter };
module.exports = {
  PostgresAdapter
};
