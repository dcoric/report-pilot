/**
 * Shared types and the `DbAdapter` contract that all database adapters
 * (Postgres, MSSQL, ...) implement.
 *
 * Keep this file focused on the public surface that services rely on.
 * DB-specific helpers should remain inside their adapter modules.
 */

export type DbDialect = "postgres" | "mssql";

/** Tables / views surfaced by introspection. */
export interface SchemaObject {
  schemaName: string;
  objectName: string;
  objectType: "table" | "view";
}

export interface SchemaColumn {
  schemaName: string;
  objectName: string;
  columnName: string;
  dataType: string;
  nullable: boolean;
  isPk: boolean;
  ordinalPosition: number;
}

export interface SchemaRelationship {
  fromSchema: string;
  fromObject: string;
  fromColumn: string;
  toSchema: string;
  toObject: string;
  toColumn: string;
  relationshipType: "fk";
}

export interface SchemaIndex {
  schemaName: string;
  objectName: string;
  indexName: string;
  columns: string[];
  isUnique: boolean;
}

/** Shape returned by `DbAdapter.introspectSchema`. */
export interface SchemaIntrospection {
  objects: SchemaObject[];
  columns: SchemaColumn[];
  relationships: SchemaRelationship[];
  indexes: SchemaIndex[];
}

/** Result row keyed by column name; values are JSON-safe primitives or Dates. */
export type QueryResultRow = Record<string, unknown>;

/** Standard shape returned by `executeReadOnly` / `executeParameterizedReadOnly`. */
export interface QueryResult {
  columns: string[];
  rows: QueryResultRow[];
  rowCount: number;
  originalRowCount: number;
  truncated: boolean;
  durationMs: number;
}

/** Options accepted by the read-only execute family. */
export interface ExecuteOptions {
  timeoutMs?: number;
  maxRows?: number;
}

/**
 * One entry in the optional `paramSchema` array used by
 * `executeParameterizedReadOnly` (MSSQL needs type hints; Postgres ignores it).
 */
export interface ParameterSchemaEntry {
  name: string;
  type?: "integer" | "decimal" | "date" | "timestamp" | "boolean" | "text" | string;
}

/** Outcome of `validateSql`. */
export interface SqlValidationResult {
  ok: boolean;
  errors: string[];
  refs?: unknown[];
}

/** Generic adapter base; per-dialect adapters narrow `type` further. */
export interface DbAdapter {
  /** Discriminant — handy for narrowing in callers when needed. */
  readonly type: DbDialect;

  /** Stable identifier used by SQL safety validation. */
  dialect(): DbDialect;

  /** Throws if the connection cannot be established. */
  testConnection(): Promise<void>;

  /** Reads the live schema (objects, columns, relationships, indexes). */
  introspectSchema(): Promise<SchemaIntrospection>;

  /**
   * Read-only validation hook.
   *
   * Both adapters run `validateAstReadOnly`; MSSQL additionally pre-flights with
   * `sp_describe_first_result_set` when permitted.
   *
   * Note: this is exposed in addition to `execute` because services call it
   * before they execute (so they can surface validation errors without
   * actually running the SQL).
   */
  validateSql(sql: string): Promise<SqlValidationResult>;

  /** Engine-specific EXPLAIN output, returned as an array of rows. */
  explain(sql: string): Promise<unknown[]>;

  /**
   * Generic single-shot execute. Defined per ticket; not heavily used in the
   * current codebase (services prefer the read-only variants below), but kept
   * on the interface so future callers have a typed surface.
   */
  execute(sql: string, params?: unknown[]): Promise<QueryResult>;

  /** Read-only execute that wraps the statement in a transaction with timeouts. */
  executeReadOnly(sql: string, opts?: ExecuteOptions): Promise<QueryResult>;

  /**
   * Read-only execute for parameterized SQL. `paramSchema` is optional and
   * only meaningful for MSSQL; Postgres ignores it.
   */
  executeParameterizedReadOnly(
    sql: string,
    paramValues: Record<string, unknown>,
    paramSchema?: ParameterSchemaEntry[],
    opts?: ExecuteOptions
  ): Promise<QueryResult>;

  /** Quote a SQL identifier for the adapter's dialect. */
  quoteIdentifier(identifier: string): string;

  /** Releases pooled connections. Safe to call once during shutdown. */
  close(): Promise<void>;
}
