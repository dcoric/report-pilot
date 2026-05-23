import { Pool, type PoolClient, type QueryResult, type QueryResultRow } from "pg";

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  throw new Error("DATABASE_URL is not set");
}

const pool: Pool = new Pool({
  connectionString: DATABASE_URL
});

async function query<T extends QueryResultRow = QueryResultRow>(
  text: string,
  params: unknown[] = []
): Promise<QueryResult<T>> {
  return pool.query<T>(text, params);
}

async function withTransaction<T>(handler: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await handler(client);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

async function close(): Promise<void> {
  await pool.end();
}

// Use CommonJS `module.exports` so callers (and tests) can mutate properties
// on the imported module object (e.g. `appDb.query = stub` in tests).
// Named `export` statements compile to immutable getters under tsx/esbuild.
export = {
  pool,
  query,
  withTransaction,
  close
};
