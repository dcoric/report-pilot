import type { DbAdapter, DbDialect } from "./types";

const { PostgresAdapter } = require("./postgresAdapter") as {
  PostgresAdapter: new (connectionString: string) => DbAdapter;
};
const { MssqlAdapter } = require("./mssqlAdapter") as {
  MssqlAdapter: new (connectionString: string) => DbAdapter;
};

const SUPPORTED_DB_TYPES: ReadonlyArray<DbDialect> = ["postgres", "mssql"] as const;
const SUPPORTED_DB_TYPE_SET: ReadonlySet<DbDialect> = new Set<DbDialect>(SUPPORTED_DB_TYPES);

function createDatabaseAdapter(dbType: string, connectionRef: string): DbAdapter {
  if (!SUPPORTED_DB_TYPE_SET.has(dbType as DbDialect)) {
    throw new Error(`Unsupported db_type: ${dbType}`);
  }

  if (dbType === "postgres") {
    return new PostgresAdapter(connectionRef);
  }
  if (dbType === "mssql") {
    return new MssqlAdapter(connectionRef);
  }

  throw new Error(`Unsupported db_type: ${dbType}`);
}

function isSupportedDbType(dbType: string): boolean {
  return SUPPORTED_DB_TYPE_SET.has(dbType as DbDialect);
}

export { SUPPORTED_DB_TYPES, createDatabaseAdapter, isSupportedDbType };
module.exports = {
  SUPPORTED_DB_TYPES,
  createDatabaseAdapter,
  isSupportedDbType
};
