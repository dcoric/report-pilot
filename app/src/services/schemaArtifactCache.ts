import appDb = require("../lib/appDb");

export type SchemaArtifactKind = "table_cards" | "schema_graph";

interface CacheEntry {
  dataSourceId: string;
  value: Promise<unknown>;
}

const MAX_CACHE_ENTRIES = 128;
const cache = new Map<string, CacheEntry>();

export async function loadCurrentSchemaVersion(dataSourceId: string): Promise<number> {
  const result = await appDb.query<{ schema_version: number | string }>(
    "SELECT schema_version FROM rag_index_state WHERE data_source_id = $1",
    [dataSourceId]
  );
  return Number(result.rows[0]?.schema_version || 0);
}

export async function getOrLoadSchemaArtifact<T>(
  kind: SchemaArtifactKind,
  dataSourceId: string,
  schemaVersion: number,
  loader: () => Promise<T>
): Promise<T> {
  const key = cacheKey(kind, dataSourceId, schemaVersion);
  const existing = cache.get(key);
  if (existing) {
    cache.delete(key);
    cache.set(key, existing);
    return existing.value as Promise<T>;
  }

  const value = loader();
  cache.set(key, { dataSourceId, value });
  evictOldestEntries();
  try {
    return await value;
  } catch (err) {
    if (cache.get(key)?.value === value) cache.delete(key);
    throw err;
  }
}

export function invalidateSchemaArtifacts(dataSourceId: string): number {
  let removed = 0;
  for (const [key, entry] of cache) {
    if (entry.dataSourceId === dataSourceId) {
      cache.delete(key);
      removed += 1;
    }
  }
  return removed;
}

export function clearSchemaArtifactCache(): void {
  cache.clear();
}

function cacheKey(kind: SchemaArtifactKind, dataSourceId: string, schemaVersion: number): string {
  return `${kind}:${dataSourceId}:${schemaVersion}`;
}

function evictOldestEntries(): void {
  while (cache.size > MAX_CACHE_ENTRIES) {
    const oldestKey = cache.keys().next().value as string | undefined;
    if (!oldestKey) return;
    cache.delete(oldestKey);
  }
}
