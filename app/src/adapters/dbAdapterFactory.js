const { PostgresAdapter } = require("./postgresAdapter");
const { MssqlAdapter } = require("./mssqlAdapter");

const SUPPORTED_DB_TYPES = ["postgres", "mssql"];
const SUPPORTED_DB_TYPE_SET = new Set(SUPPORTED_DB_TYPES);

function createDatabaseAdapter(dbType, connectionRef) {
  if (!SUPPORTED_DB_TYPE_SET.has(dbType)) {
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

function isSupportedDbType(dbType) {
  return SUPPORTED_DB_TYPE_SET.has(dbType);
}

module.exports = {
  SUPPORTED_DB_TYPES,
  createDatabaseAdapter,
  isSupportedDbType
};
