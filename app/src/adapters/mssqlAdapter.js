const sql = require("mssql");
const { validateAstReadOnly } = require("../services/sqlAstValidator");

class MssqlAdapter {
  constructor(connectionString) {
    this.connectionString = connectionString;
    this.pool = new sql.ConnectionPool(buildMssqlConfig(connectionString));
    this.poolConnect = this.pool.connect();
  }

  type = "mssql";

  dialect() {
    return "mssql";
  }

  async close() {
    try {
      await this.pool.close();
    } catch {
      // ignore close errors during shutdown path
    }
  }

  async testConnection() {
    await this.query("SELECT 1 AS one");
  }

  async introspectSchema() {
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
      (tables(pkResult)).map((row) => `${row.schema_name}.${row.object_name}.${row.column_name}`)
    );

    const objects = tables(tablesResult).map((row) => ({
      schemaName: row.schema_name,
      objectName: row.object_name,
      objectType: row.table_type === "VIEW" ? "view" : "table"
    }));

    const columns = tables(columnsResult).map((row) => ({
      schemaName: row.schema_name,
      objectName: row.object_name,
      columnName: row.column_name,
      dataType: row.data_type,
      nullable: String(row.is_nullable).toUpperCase() === "YES",
      isPk: pkSet.has(`${row.schema_name}.${row.object_name}.${row.column_name}`),
      ordinalPosition: row.ordinal_position
    }));

    const relationships = tables(fkResult).map((row) => ({
      fromSchema: row.from_schema,
      fromObject: row.from_table,
      fromColumn: row.from_column,
      toSchema: row.to_schema,
      toObject: row.to_table,
      toColumn: row.to_column,
      relationshipType: "fk"
    }));

    const indexes = tables(indexesResult).map((row) => ({
      schemaName: row.schema_name,
      objectName: row.object_name,
      indexName: row.index_name,
      columns: parseIndexColumns(row.index_columns),
      isUnique: Boolean(row.is_unique)
    }));

    return { objects, columns, relationships, indexes };
  }

  async validateSql(sqlText) {
    return validateAstReadOnly(sqlText, [], this.dialect());
  }

  async explain(sqlText) {
    const normalizedSql = String(sqlText || "").replace(/;\s*$/, "");
    const planResult = await this.query(`
      SET SHOWPLAN_JSON ON;
      ${normalizedSql};
      SET SHOWPLAN_JSON OFF;
    `);
    return Array.isArray(planResult.recordsets) ? planResult.recordsets.flat() : tables(planResult);
  }

  async executeReadOnly(sqlText, opts = {}) {
    const timeoutMs = Number(opts.timeoutMs || 20000);
    const maxRows = Number(opts.maxRows || 1000);
    const startedAt = Date.now();

    const result = await this.query(sqlText, timeoutMs);
    const rows = tables(result);
    const columns = extractColumns(result, rows);
    const truncated = rows.length > maxRows;
    const slicedRows = truncated ? rows.slice(0, maxRows) : rows;
    const safeRows = slicedRows.map((row) => sanitizeRow(row));

    return {
      columns,
      rows: safeRows,
      rowCount: safeRows.length,
      originalRowCount: rows.length,
      truncated,
      durationMs: Date.now() - startedAt
    };
  }

  quoteIdentifier(identifier) {
    return `[${String(identifier).replace(/]/g, "]]")}]`;
  }

  async query(sqlText, timeoutMs) {
    await this.poolConnect;
    const request = this.pool.request();
    if (Number.isFinite(timeoutMs)) {
      request.timeout = timeoutMs;
    }
    return request.query(sqlText);
  }
}

function buildMssqlConfig(connectionString) {
  const raw = String(connectionString || "").trim();
  if (!raw) {
    throw new Error("MSSQL connection string is empty");
  }

  if (/^server=/i.test(raw) || raw.includes(";")) {
    const parts = parseKvConnectionString(raw);
    const trusted = parseBoolean(parts.trusted_connection || parts.integrated_security || parts.integratedsecurity);
    if (trusted) {
      throw new Error("Trusted_Connection is not supported by this runtime. Use User Id + Password.");
    }

    const serverField = parts.server || parts.data_source || parts.address || parts.addr || parts.network_address;
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
    };
  }

  return {
    connectionString: raw,
    options: {
      encrypt: true,
      trustServerCertificate: true
    }
  };
}

function parseKvConnectionString(raw) {
  return raw
    .split(";")
    .map((part) => part.trim())
    .filter(Boolean)
    .reduce((acc, item) => {
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

function splitServerHostAndPort(serverField) {
  const value = String(serverField || "").trim();
  if (!value) {
    return { host: "", port: 1433, instanceName: null };
  }
  if (value.includes(",")) {
    const [host, portRaw] = value.split(",", 2);
    const port = Number(portRaw);
    return { host: host.trim(), port: Number.isFinite(port) ? port : 1433, instanceName: null };
  }
  if (value.includes("\\")) {
    const [host, instance] = value.split("\\", 2);
    return { host: host.trim(), port: 1433, instanceName: instance ? instance.trim() : null };
  }
  return { host: value, port: 1433, instanceName: null };
}

function parseBoolean(value, fallback = false) {
  if (value === undefined || value === null || value === "") {
    return fallback;
  }
  const normalized = String(value).trim().toLowerCase();
  return ["true", "1", "yes", "y"].includes(normalized);
}

function tables(result) {
  return Array.isArray(result?.recordset) ? result.recordset : [];
}

function extractColumns(result, rows) {
  if (rows.length > 0) {
    return Object.keys(rows[0]);
  }

  const colMeta = result?.recordset?.columns;
  if (colMeta && typeof colMeta === "object") {
    return Object.keys(colMeta);
  }
  return [];
}

function sanitizeRow(row) {
  const out = {};
  for (const key of Object.keys(row || {})) {
    out[key] = sanitizeValue(row[key]);
  }
  return out;
}

function sanitizeValue(value) {
  if (value === null || value === undefined) {
    return null;
  }
  if (Buffer.isBuffer(value)) {
    return value.toString("base64");
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

function parseIndexColumns(rawColumns) {
  return String(rawColumns || "")
    .split(",")
    .map((part) => part.trim().replace(/[\[\]]/g, ""))
    .filter(Boolean);
}

module.exports = {
  MssqlAdapter
};
