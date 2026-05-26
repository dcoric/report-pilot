import * as fs from "fs/promises";
import * as path from "path";
import { Client } from "pg";
import { errorMessage } from "./lib/http";

const MIGRATIONS_DIR = process.env.MIGRATIONS_DIR || path.join(process.cwd(), "db", "migrations");
const DATABASE_URL = process.env.DATABASE_URL;

export interface RunMigrationsOptions {
  maxRetries?: number;
  delayMs?: number;
}

async function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function connectWithRetry(maxRetries = 20, delayMs = 2000): Promise<Client> {
  if (!DATABASE_URL) {
    throw new Error("DATABASE_URL is not set");
  }

  let lastError: unknown;
  for (let attempt = 1; attempt <= maxRetries; attempt += 1) {
    const client = new Client({ connectionString: DATABASE_URL });
    try {
      await client.connect();
      return client;
    } catch (err) {
      lastError = err;
      console.error(`[migrate] DB connection attempt ${attempt}/${maxRetries} failed: ${errorMessage(err)}`);
      await sleep(delayMs);
    }
  }

  throw new Error(`[migrate] Could not connect to database after retries: ${errorMessage(lastError)}`);
}

async function ensureMigrationsTable(client: Client): Promise<void> {
  await client.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      name TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);
}

async function listMigrationFiles(): Promise<string[]> {
  const entries = await fs.readdir(MIGRATIONS_DIR, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".sql"))
    .map((entry) => entry.name)
    .sort();
}

async function isApplied(client: Client, migrationName: string): Promise<boolean> {
  const result = await client.query("SELECT 1 FROM schema_migrations WHERE name = $1", [migrationName]);
  return (result.rowCount ?? 0) > 0;
}

async function applyMigration(client: Client, migrationName: string): Promise<void> {
  const migrationPath = path.join(MIGRATIONS_DIR, migrationName);
  const sql = await fs.readFile(migrationPath, "utf8");

  await client.query("BEGIN");
  try {
    await client.query(sql);
    await client.query("INSERT INTO schema_migrations(name) VALUES ($1)", [migrationName]);
    await client.query("COMMIT");
    console.log(`[migrate] Applied ${migrationName}`);
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  }
}

export async function runMigrations(options: RunMigrationsOptions = {}): Promise<void> {
  const maxRetries = options.maxRetries ?? 20;
  const delayMs = options.delayMs ?? 2000;
  const client = await connectWithRetry(maxRetries, delayMs);

  try {
    await ensureMigrationsTable(client);

    const migrationFiles = await listMigrationFiles();
    if (migrationFiles.length === 0) {
      console.log("[migrate] No migration files found.");
      return;
    }

    for (const migrationName of migrationFiles) {
      const applied = await isApplied(client, migrationName);
      if (applied) {
        console.log(`[migrate] Skipping already applied ${migrationName}`);
        continue;
      }
      await applyMigration(client, migrationName);
    }

    console.log("[migrate] Migration run complete.");
  } finally {
    await client.end();
  }
}

if (require.main === module) {
  runMigrations().catch((err: unknown) => {
    console.error(`[migrate] Failed: ${errorMessage(err)}`);
    process.exit(1);
  });
}
