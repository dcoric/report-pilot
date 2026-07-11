import * as sql from "mssql";
import type { ConnectionPool, IResult, IRecordSet, ISqlType, config as MssqlConfig, Request as MssqlRequest } from "mssql";
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

const { validateAstReadOnly } = require("../services/sqlAstValidator");
const {
  extractPlaceholders,
  replaceNamedPlaceholders
} = require("../services/queryParameterParser");

class MssqlAdapter implements DbAdapter {
  public readonly type: "mssql" = "mssql";
  public readonly connectionString: string;
  public readonly pool: ConnectionPool;
  public readonly poolConnect: Promise<ConnectionPool>;

  constructor(connectionString: string) {
    this.connectionString = connectionString;
    this.pool = new sql.ConnectionPool(buildMssqlConfig(connectionString));
    this.poolConnect = this.pool.connect();
  }

  dialect(): DbDialect {
    return "mssql";
  }

  async close(): Promise<void> {
    try {
      await this.pool.close();
    } catch {
      // ignore close errors during shutdown path
    }
  }

  async testConnection(): Promise<void> {
    await this.query("SELECT 1 AS one");
  }

  async introspectSchema(): Promise<SchemaIntrospection> {
    const tablesSql = `
      SELECT
        t.TABLE_SCHEMA AS schema_name,
        t.TABLE_NAME AS object_name,
        t.TABLE_TYPE AS table_type
      FROM INFORMATION_SCHEMA.TABLES t
      WHERE t.TABLE_SCHEMA NOT IN ('sys', 'INFORMATION_SCHEMA')
      ORDER BY t.TABLE_SCHEMA, t.TABLE_NAME;
    `;

    const columnsSql = `
      SELECT
        c.TABLE_SCHEMA AS schema_name,
        c.TABLE_NAME AS object_name,
        c.COLUMN_NAME AS column_name,
        c.DATA_TYPE AS data_type,
        c.IS_NULLABLE AS is_nullable,
        c.ORDINAL_POSITION AS ordinal_position
      FROM INFORMATION_SCHEMA.COLUMNS c
      WHERE c.TABLE_SCHEMA NOT IN ('sys', 'INFORMATION_SCHEMA')
      ORDER BY c.TABLE_SCHEMA, c.TABLE_NAME, c.ORDINAL_POSITION;
    `;

    const pkSql = `
      SELECT
        kcu.TABLE_SCHEMA AS schema_name,
        kcu.TABLE_NAME AS object_name,
        kcu.COLUMN_NAME AS column_name
      FROM INFORMATION_SCHEMA.TABLE_CONSTRAINTS tc
      JOIN INFORMATION_SCHEMA.KEY_COLUMN_USAGE kcu
        ON tc.CONSTRAINT_NAME = kcu.CONSTRAINT_NAME
       AND tc.TABLE_SCHEMA = kcu.TABLE_SCHEMA
      WHERE tc.CONSTRAINT_TYPE = 'PRIMARY KEY'
        AND kcu.TABLE_SCHEMA NOT IN ('sys', 'INFORMATION_SCHEMA');
    `;

    const fkSql = `
      SELECT
        s1.name AS from_schema,
        t1.name AS from_table,
        c1.name AS from_column,
        s2.name AS to_schema,
        t2.name AS to_table,
        c2.name AS to_column
      FROM sys.foreign_key_columns fkc
      JOIN sys.tables t1
        ON fkc.parent_object_id = t1.object_id
      JOIN sys.schemas s1
        ON t1.schema_id = s1.schema_id
      JOIN sys.columns c1
        ON fkc.parent_object_id = c1.object_id
       AND fkc.parent_column_id = c1.column_id
      JOIN sys.tables t2
        ON fkc.referenced_object_id = t2.object_id
      JOIN sys.schemas s2
        ON t2.schema_id = s2.schema_id
      JOIN sys.columns c2
        ON fkc.referenced_object_id = c2.object_id
       AND fkc.referenced_column_id = c2.column_id
      WHERE s1.name NOT IN ('sys', 'INFORMATION_SCHEMA')
      ORDER BY s1.name, t1.name, c1.name;
    `;

    const indexesSql = `
      SELECT
        s.name AS schema_name,
        t.name AS object_name,
        ix.name AS index_name,
        ix.is_unique AS is_unique,
        STRING_AGG(col.name, ',') WITHIN GROUP (ORDER BY ic.key_ordinal) AS index_columns
      FROM sys.indexes ix
      JOIN sys.tables t
        ON ix.object_id = t.object_id
      JOIN sys.schemas s
        ON t.schema_id = s.schema_id
      LEFT JOIN sys.index_columns ic
        ON ix.object_id = ic.object_id
       AND ix.index_id = ic.index_id
       AND ic.key_ordinal > 0
      LEFT JOIN sys.columns col
        ON ic.object_id = col.object_id
       AND ic.column_id = col.column_id
      WHERE ix.is_hypothetical = 0
        AND ix.name IS NOT NULL
        AND s.name NOT IN ('sys', 'INFORMATION_SCHEMA')
      GROUP BY s.name, t.name, ix.name, ix.is_unique
      ORDER BY s.name, t.name, ix.name;
    `;

    const [tablesResult, columnsResult, pkResult, fkResult, indexesResult] = await Promise.all([
      this.query(tablesSql),
      this.query(columnsSql),
      this.query(pkSql),
      this.query(fkSql),
      this.query(indexesSql)
    ]);

    const pkSet = new Set(
      tablesRows(pkResult).map(
        (row) => `${String(row.schema_name)}.${String(row.object_name)}.${String(row.column_name)}`
      )
    );

    const objects = tablesRows(tablesResult).map((row) => ({
      schemaName: String(row.schema_name),
      objectName: String(row.object_name),
      objectType: (row.table_type === "VIEW" ? "view" : "table") as "table" | "view"
    }));

    const columns = tablesRows(columnsResult).map((row) => ({
      schemaName: String(row.schema_name),
      objectName: String(row.object_name),
      columnName: String(row.column_name),
      dataType: String(row.data_type),
      nullable: String(row.is_nullable).toUpperCase() === "YES",
      isPk: pkSet.has(`${row.schema_name}.${row.object_name}.${row.column_name}`),
      ordinalPosition: Number(row.ordinal_position)
    }));

    const relationships = tablesRows(fkResult).map((row) => ({
      fromSchema: String(row.from_schema),
      fromObject: String(row.from_table),
      fromColumn: String(row.from_column),
      toSchema: String(row.to_schema),
      toObject: String(row.to_table),
      toColumn: String(row.to_column),
      relationshipType: "fk" as const
    }));

    const indexes = tablesRows(indexesResult).map((row) => ({
      schemaName: String(row.schema_name),
      objectName: String(row.object_name),
      indexName: String(row.index_name),
      columns: parseIndexColumns(String(row.index_columns || "")),
      isUnique: Boolean(row.is_unique)
    }));

    return { objects, columns, relationships, indexes };
  }

  async validateSql(sqlText: string): Promise<SqlValidationResult> {
    const readOnlyCheck: SqlValidationResult = validateAstReadOnly(sqlText, [], this.dialect());
    if (!readOnlyCheck.ok) {
      return readOnlyCheck;
    }

    try {
      await this.describeFirstResultSet(sqlText);
      return readOnlyCheck;
    } catch (err) {
      if (isDescribeFirstResultUnavailable(err)) {
        return readOnlyCheck;
      }
      return {
        ok: false,
        errors: [normalizeMssqlValidationError(err)],
        refs: readOnlyCheck.refs || []
      };
    }
  }

  async explain(sqlText: string): Promise<unknown[]> {
    const normalizedSql = String(sqlText || "").replace(/;\s*$/, "");
    const planResult = await this.query(`
      SET SHOWPLAN_JSON ON;
      ${normalizedSql};
      SET SHOWPLAN_JSON OFF;
    `);
    return Array.isArray(planResult.recordsets)
      ? planResult.recordsets.flatMap((recordset) => Array.from(recordset))
      : tablesRows(planResult);
  }

  async execute(sqlText: string, params: unknown[] = []): Promise<QueryResult> {
    return this.executeWithRequest((request) => {
      params.forEach((value, index) => {
        request.input(`p${index}`, value);
      });
      return request.query(sqlText);
    }, {});
  }

  async executeReadOnly(sqlText: string, opts: ExecuteOptions = {}): Promise<QueryResult> {
    return this.executeWithRequest((request) => request.query(sqlText), opts);
  }

  async executeParameterizedReadOnly(
    sqlText: string,
    paramValues: Record<string, unknown>,
    paramSchema?: ParameterSchemaEntry[],
    opts: ExecuteOptions = {}
  ): Promise<QueryResult> {
    const placeholders: string[] = extractPlaceholders(sqlText);
    const schemaByName = new Map<string, ParameterSchemaEntry>(
      (Array.isArray(paramSchema) ? paramSchema : []).map(
        (entry: ParameterSchemaEntry) => [entry.name, entry]
      )
    );
    const usedNames = new Set<string>();
    const transformedSql: string = replaceNamedPlaceholders(sqlText, (name: string) => {
      usedNames.add(name);
      return `@${name}`;
    });

    return this.executeWithRequest((request) => {
      for (const name of placeholders) {
        if (
          usedNames.has(name) &&
          !Object.prototype.hasOwnProperty.call(paramValues || {}, name)
        ) {
          throw new Error(`Missing parameter value for :${name}`);
        }
        if (!usedNames.has(name)) {
          continue;
        }
        const type = schemaByName.get(name)?.type || "text";
        request.input(
          name,
          getMssqlParameterType(type),
          convertMssqlParameterValue(type, paramValues[name])
        );
      }
      return request.query(transformedSql);
    }, opts);
  }

  async executeWithRequest(
    runQuery: (request: MssqlRequest) => Promise<IResult<unknown>>,
    opts: ExecuteOptions = {}
  ): Promise<QueryResult> {
    const timeoutMs = Number(opts.timeoutMs || 20000);
    const maxRows = Number(opts.maxRows || 1000);
    const startedAt = Date.now();

    await this.poolConnect;
    const request = this.pool.request();
    const result = await runMssqlRequestWithTimeout(request, timeoutMs, () => runQuery(request));
    const rows = tablesRows(result);
    const columns = extractColumns(result, rows);
    const truncated = rows.length > maxRows;
    const slicedRows = truncated ? rows.slice(0, maxRows) : rows;
    const safeRows: QueryResultRow[] = slicedRows.map((row) => sanitizeRow(row));

    return {
      columns,
      rows: safeRows,
      rowCount: safeRows.length,
      originalRowCount: rows.length,
      truncated,
      durationMs: Date.now() - startedAt
    };
  }

  quoteIdentifier(identifier: string): string {
    return `[${String(identifier).replace(/]/g, "]]")}]`;
  }

  async describeFirstResultSet(sqlText: string): Promise<IResult<unknown>> {
    await this.poolConnect;
    const request = this.pool.request();
    request.input("tsql", sql.NVarChar(sql.MAX), String(sqlText || "").trim());
    return request.query(`
      EXEC sys.sp_describe_first_result_set
        @tsql = @tsql,
        @params = NULL,
        @browse_information_mode = 0;
    `);
  }

  async query(sqlText: string, timeoutMs?: number): Promise<IResult<unknown>> {
    await this.poolConnect;
    const request = this.pool.request();
    return runMssqlRequestWithTimeout(request, timeoutMs, () => request.query(sqlText));
  }
}

function buildMssqlConfig(connectionString: string): MssqlConfig {
  const raw = String(connectionString || "").trim();
  if (!raw) {
    throw new Error("MSSQL connection string is empty");
  }

  if (/^server=/i.test(raw) || raw.includes(";")) {
    const parts = parseKvConnectionString(raw);
    const trusted = parseBoolean(
      parts.trusted_connection || parts.integrated_security || parts.integratedsecurity
    );
    if (trusted) {
      throw new Error(
        "Trusted_Connection is not supported by this runtime. Use User Id + Password."
      );
    }

    const serverField =
      parts.server || parts.data_source || parts.address || parts.addr || parts.network_address;
    const { host, port, instanceName } = splitServerHostAndPort(serverField);
    const encrypt = parseBoolean(parts.encrypt, true);
    const trustServerCertificate = parseBoolean(
      parts.trustservercertificate || parts.trust_server_certificate,
      false
    );
    const user = parts.user_id || parts.uid || parts.user || parts.username;
    const password = parts.password || parts.pwd;
    const database = parts.database || parts.initial_catalog;

    if (!host) {
      throw new Error("MSSQL connection string must include Server");
    }
    if (!database) {
      throw new Error("MSSQL connection string must include Database");
    }
    if (!user || !password) {
      throw new Error("MSSQL connection string must include User Id and Password");
    }

    return {
      user,
      password,
      server: host,
      database,
      ...(instanceName ? {} : { port }),
      options: {
        encrypt,
        trustServerCertificate,
        ...(instanceName ? { instanceName } : {})
      },
      pool: {
        max: 10,
        min: 0,
        idleTimeoutMillis: 30000
      }
    } as MssqlConfig;
  }

  return {
    connectionString: raw,
    options: {
      encrypt: true,
      trustServerCertificate: true
    }
  } as unknown as MssqlConfig;
}

function parseKvConnectionString(raw: string): Record<string, string> {
  return raw
    .split(";")
    .map((part) => part.trim())
    .filter(Boolean)
    .reduce<Record<string, string>>((acc, item) => {
      const idx = item.indexOf("=");
      if (idx <= 0) {
        return acc;
      }
      const key = item.slice(0, idx).trim().toLowerCase().replace(/\s+/g, "_");
      const value = item.slice(idx + 1).trim();
      acc[key] = value;
      return acc;
    }, {});
}

interface SplitServer {
  host: string;
  port: number;
  instanceName: string | null;
}

function splitServerHostAndPort(serverField: string | undefined): SplitServer {
  const value = String(serverField || "").trim();
  if (!value) {
    return { host: "", port: 1433, instanceName: null };
  }
  if (value.includes(",")) {
    const [host, portRaw] = value.split(",", 2);
    const port = Number(portRaw);
    return {
      host: host.trim(),
      port: Number.isFinite(port) ? port : 1433,
      instanceName: null
    };
  }
  if (value.includes("\\")) {
    const [host, instance] = value.split("\\", 2);
    return { host: host.trim(), port: 1433, instanceName: instance ? instance.trim() : null };
  }
  return { host: value, port: 1433, instanceName: null };
}

function parseBoolean(value: unknown, fallback: boolean = false): boolean {
  if (value === undefined || value === null || value === "") {
    return fallback;
  }
  const normalized = String(value).trim().toLowerCase();
  return ["true", "1", "yes", "y"].includes(normalized);
}

async function runMssqlRequestWithTimeout<T>(
  request: MssqlRequest,
  timeoutMs: number | undefined,
  operation: () => Promise<T>
): Promise<T> {
  if (typeof timeoutMs !== "number" || !Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    return operation();
  }

  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      try {
        request.cancel();
      } catch {
        // The request may have completed between the timer firing and cancellation.
      }
      reject(new Error(`MSSQL request timed out after ${timeoutMs}ms`));
    }, timeoutMs);
  });

  try {
    return await Promise.race([operation(), timedOut]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function tablesRows(result: IResult<unknown>): QueryResultRow[] {
  return Array.isArray(result.recordset) ? (result.recordset as QueryResultRow[]) : [];
}

function extractColumns(result: IResult<unknown>, rows: QueryResultRow[]): string[] {
  if (rows.length > 0) {
    return Object.keys(rows[0]);
  }

  const colMeta = (result?.recordset as IRecordSet<unknown> | undefined)?.columns;
  if (colMeta && typeof colMeta === "object") {
    return Object.keys(colMeta);
  }
  return [];
}

function sanitizeRow(row: QueryResultRow | null | undefined): QueryResultRow {
  const out: QueryResultRow = {};
  for (const key of Object.keys(row || {})) {
    out[key] = sanitizeValue((row as Record<string, unknown>)[key]);
  }
  return out;
}

function sanitizeValue(value: unknown): unknown {
  if (value === null || value === undefined) {
    return null;
  }
  if (Buffer.isBuffer(value)) {
    return (value as Buffer).toString("base64");
  }
  if (typeof value === "bigint") {
    return value.toString();
  }
  if (Array.isArray(value)) {
    return value.map((item) => sanitizeValue(item));
  }
  if (value instanceof Date) {
    return value;
  }
  if (typeof value === "object") {
    return JSON.stringify(value);
  }
  return value;
}

function parseIndexColumns(rawColumns: string): string[] {
  return String(rawColumns || "")
    .split(",")
    .map((part) => part.trim().replace(/[\[\]]/g, ""))
    .filter(Boolean);
}

function getMssqlParameterType(type: string): ISqlType | (() => ISqlType) {
  if (type === "integer") {
    return sql.Int;
  }
  if (type === "decimal") {
    return sql.Decimal(18, 6);
  }
  if (type === "date") {
    return sql.Date;
  }
  if (type === "boolean") {
    return sql.Bit;
  }
  if (type === "timestamp") {
    return sql.DateTime2;
  }
  return sql.NVarChar(sql.MAX);
}

function convertMssqlParameterValue(type: string, value: unknown): unknown {
  if (value === null || value === undefined) {
    return null;
  }
  if (type === "timestamp") {
    return new Date(value as string | number | Date);
  }
  if (type === "date") {
    return new Date(`${value}T00:00:00.000Z`);
  }
  return value;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object"
    ? value as Record<string, unknown>
    : null;
}

function nestedMessage(value: unknown, ...path: string[]): unknown {
  let current: unknown = value;
  for (const key of path) {
    const record = asRecord(current);
    if (!record) return undefined;
    current = record[key];
  }
  return current;
}

function normalizeMssqlValidationError(err: unknown): string {
  const precedingErrors = nestedMessage(err, "precedingErrors");
  const candidates = [
    nestedMessage(err, "originalError", "info", "message"),
    Array.isArray(precedingErrors) ? nestedMessage(precedingErrors[0], "message") : null,
    nestedMessage(err, "message")
  ];

  const message =
    candidates.map((item) => String(item || "").trim()).find(Boolean) || "SQL validation failed";

  return (
    message
      .split(/\r?\n/)
      .map((line: string) => line.trim())
      .find(Boolean) || message
  );
}

function isDescribeFirstResultUnavailable(err: unknown): boolean {
  const message = String(nestedMessage(err, "message") || "").toLowerCase();
  return (
    message.includes("sp_describe_first_result_set") &&
    (message.includes("permission") || message.includes("could not find stored procedure"))
  );
}

export { MssqlAdapter };
module.exports = {
  MssqlAdapter
};
