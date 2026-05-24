import appDb = require("../lib/appDb");
import { createDatabaseAdapter } from "../adapters/dbAdapterFactory";
import { stringify } from "csv-stringify/sync";
import * as xlsx from "xlsx";
import * as parquet from "parquetjs-lite";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";

export type ExportFormat = "json" | "csv" | "xlsx" | "tsv" | "parquet";

export const SUPPORTED_FORMATS: ReadonlySet<ExportFormat> = new Set<ExportFormat>(["json", "csv", "xlsx", "tsv", "parquet"]);

export interface ExportResult {
  buffer: Buffer;
  contentType: string;
  filename: string;
}

type ParquetPrimitive = "BOOLEAN" | "INT64" | "DOUBLE" | "TIMESTAMP_MILLIS" | "UTF8";

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})?)?$/;

/**
 * Exports current query results for a given session.
 * Re-runs the *latest successful* SQL generation for the session to get a fresh cursor/result.
 */
export async function exportQueryResult(sessionId: string, format: ExportFormat = "json"): Promise<ExportResult> {
  if (!SUPPORTED_FORMATS.has(format)) {
    throw new Error(`Unsupported format: ${format}`);
  }

  // 1. Fetch session and check data source info
  const sessionResult = await appDb.query<{
    id: string;
    data_source_id: string;
    question: string | null;
    connection_ref: string;
    db_type: string;
  }>(
    `
      SELECT
        qs.id,
        qs.data_source_id,
        qs.question,
        ds.connection_ref,
        ds.db_type
      FROM query_sessions qs
      JOIN data_sources ds ON ds.id = qs.data_source_id
      WHERE qs.id = $1
    `,
    [sessionId]
  );

  if (sessionResult.rowCount === 0) {
    throw new Error("Session not found");
  }

  const session = sessionResult.rows[0];

  // 2. Fetch the latest successful attempt's SQL
  const attemptResult = await appDb.query<{ generated_sql: string | null }>(
    `
      SELECT qa.generated_sql
      FROM query_attempts qa
      JOIN query_results_meta qrm ON qrm.attempt_id = qa.id
      WHERE qa.session_id = $1
      ORDER BY qa.created_at DESC
      LIMIT 1
    `,
    [sessionId]
  );

  if (attemptResult.rowCount === 0) {
    throw new Error("No successful query attempts found for this session");
  }

  const sql = attemptResult.rows[0].generated_sql;
  if (!sql) {
    throw new Error("No SQL found in latest attempt");
  }

  // 3. Re-execute the SQL (Read-Only)
  // Note: For very large datasets, we should stream. For MVP, we load into memory.
  const adapter = createDatabaseAdapter(session.db_type, session.connection_ref);
  let rows: Array<Record<string, unknown>> = [];
  let columns: string[] = [];
  try {
    const execution = await adapter.executeReadOnly(sql, { maxRows: 100000 }); // Increase limit for export
    rows = execution.rows as Array<Record<string, unknown>>;
    columns = execution.columns || [];
  } finally {
    await adapter.close();
  }

  // 4. Format Output
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const safeName = (session.question || "query").replace(/[^a-z0-9]/gi, "_").substring(0, 50);
  const filename = `${safeName}_${timestamp}.${format === "xlsx" ? "xlsx" : format}`;
  const columnOrder = getColumnOrder(columns, rows);

  let buffer: Buffer;
  let contentType: string;

  switch (format) {
    case "json": {
      const normalized = rows.map((row) => normalizeRowForJson(row, columnOrder));
      buffer = Buffer.from(JSON.stringify(normalized, null, 2), "utf-8");
      contentType = "application/json; charset=utf-8";
      break;
    }

    case "csv":
      buffer = Buffer.from(
        stringify(rows, { header: true, columns: columnOrder.length > 0 ? columnOrder : undefined }),
        "utf-8"
      );
      contentType = "text/csv; charset=utf-8";
      break;

    case "tsv":
      buffer = Buffer.from(
        stringify(rows, {
          header: true,
          columns: columnOrder.length > 0 ? columnOrder : undefined,
          delimiter: "\t"
        }),
        "utf-8"
      );
      contentType = "text/tab-separated-values; charset=utf-8";
      break;

    case "xlsx": {
      const workBook = xlsx.utils.book_new();
      const workSheet = xlsx.utils.json_to_sheet(rows, {
        header: columnOrder.length > 0 ? columnOrder : undefined
      });
      xlsx.utils.book_append_sheet(workBook, workSheet, "Results");
      buffer = xlsx.write(workBook, { type: "buffer", bookType: "xlsx" });
      contentType = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
      break;
    }

    case "parquet":
      buffer = await exportParquet(rows, columnOrder);
      contentType = "application/vnd.apache.parquet";
      break;

    default:
      throw new Error(`Unsupported format: ${format}`);
  }

  return { buffer, contentType, filename };
}

function getColumnOrder(columns: string[] | unknown, rows: Array<Record<string, unknown>>): string[] {
  if (Array.isArray(columns) && columns.length > 0) {
    return columns as string[];
  }
  if (rows.length > 0) {
    return Object.keys(rows[0]);
  }
  return [];
}

function normalizeRowForJson(row: Record<string, unknown>, columnOrder: string[]): Record<string, unknown> {
  const ordered: Record<string, unknown> = {};
  const keys = Array.isArray(columnOrder) && columnOrder.length > 0
    ? columnOrder
    : Object.keys(row || {});

  for (const key of keys) {
    ordered[key] = normalizeJsonValue(row?.[key]);
  }

  for (const key of Object.keys(row || {})) {
    if (!(key in ordered)) {
      ordered[key] = normalizeJsonValue(row[key]);
    }
  }

  return ordered;
}

function normalizeJsonValue(value: unknown): unknown {
  if (value === null || value === undefined) {
    return null;
  }

  if (typeof value === "number") {
    return Number.isFinite(value) ? value : null;
  }

  if (typeof value === "bigint") {
    return value.toString();
  }

  if (typeof value === "string" || typeof value === "boolean") {
    return value;
  }

  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value.toISOString();
  }

  if (Buffer.isBuffer(value)) {
    return value.toString("base64");
  }

  if (Array.isArray(value)) {
    return value.map((item) => normalizeJsonValue(item));
  }

  if (typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>)) {
      out[key] = normalizeJsonValue((value as Record<string, unknown>)[key]);
    }
    return out;
  }

  return String(value);
}

function inferParquetType(values: unknown[]): ParquetPrimitive {
  const presentValues = values.filter((value) => value !== null && value !== undefined);
  if (presentValues.length === 0) {
    return "UTF8";
  }
  if (presentValues.every((value) => typeof value === "boolean")) {
    return "BOOLEAN";
  }
  if (
    presentValues.every(
      (value) => typeof value === "number" && Number.isFinite(value) && Number.isInteger(value)
    )
  ) {
    return "INT64";
  }
  if (presentValues.every((value) => typeof value === "number" && Number.isFinite(value))) {
    return "DOUBLE";
  }
  if (presentValues.every((value) => isDateLike(value))) {
    return "TIMESTAMP_MILLIS";
  }
  return "UTF8";
}

function isDateLike(value: unknown): boolean {
  if (value instanceof Date) {
    return !Number.isNaN(value.getTime());
  }
  if (typeof value !== "string") {
    return false;
  }
  if (!ISO_DATE_RE.test(value)) {
    return false;
  }
  return !Number.isNaN(Date.parse(value));
}

function normalizeParquetValue(value: unknown, type: ParquetPrimitive): unknown {
  if (value === null || value === undefined) {
    return null;
  }

  if (type === "BOOLEAN") {
    if (typeof value === "boolean") {
      return value;
    }
    if (typeof value === "number") {
      return value !== 0;
    }
    if (typeof value === "string") {
      const normalized = value.trim().toLowerCase();
      if (["true", "t", "1", "yes", "y"].includes(normalized)) {
        return true;
      }
      if (["false", "f", "0", "no", "n"].includes(normalized)) {
        return false;
      }
    }
    return null;
  }

  if (type === "INT64" || type === "DOUBLE") {
    const numeric = Number(value);
    return Number.isFinite(numeric) ? numeric : null;
  }

  if (type === "TIMESTAMP_MILLIS") {
    const dateValue = value instanceof Date ? value : new Date(value as string);
    return Number.isNaN(dateValue.getTime()) ? null : dateValue;
  }

  return String(value);
}

async function exportParquet(rows: Array<Record<string, unknown>>, columnOrder: string[]): Promise<Buffer> {
  if (!Array.isArray(columnOrder) || columnOrder.length === 0) {
    throw new Error("Cannot export parquet without columns");
  }

  const schemaDefinition: Record<string, { type: ParquetPrimitive; optional: boolean }> = {};
  for (const column of columnOrder) {
    const values = rows.map((row) => row[column]);
    schemaDefinition[column] = {
      type: inferParquetType(values),
      optional: true
    };
  }

  const schema = new (parquet as { ParquetSchema: new (def: unknown) => unknown }).ParquetSchema(schemaDefinition);
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "report-pilot-export-"));
  const filePath = path.join(tempDir, `export-${Date.now()}.parquet`);

  let writer: { appendRow: (row: Record<string, unknown>) => Promise<void>; close: () => Promise<void> } | null = null;
  try {
    writer = await (parquet as {
      ParquetWriter: {
        openFile: (schema: unknown, path: string) => Promise<{ appendRow: (row: Record<string, unknown>) => Promise<void>; close: () => Promise<void> }>;
      };
    }).ParquetWriter.openFile(schema, filePath);
    for (const row of rows) {
      const normalizedRow: Record<string, unknown> = {};
      for (const column of columnOrder) {
        normalizedRow[column] = normalizeParquetValue(row[column], schemaDefinition[column].type);
      }
      await writer!.appendRow(normalizedRow);
    }
    await writer!.close();
    writer = null;

    return await fs.readFile(filePath);
  } finally {
    if (writer) {
      await writer.close().catch(() => {});
    }
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
  }
}

export const __private = {
  getColumnOrder,
  normalizeRowForJson,
  normalizeJsonValue,
  inferParquetType,
  normalizeParquetValue
};
