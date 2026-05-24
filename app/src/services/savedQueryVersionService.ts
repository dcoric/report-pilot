// QUERY-005: revision history for saved queries.
//
// `recordVersion` writes the next-numbered row using the UNIQUE
// (saved_query_id, version_number) constraint as the locking mechanism —
// on collision (rare race) the caller can retry. Since the existing API
// surface serialises edits per saved_query (one HTTP request at a time),
// collisions are unlikely in practice, but the retry loop keeps it safe.

import appDb = require("../lib/appDb");
import { isUuid, isPgUniqueViolation } from "../lib/validation";
import type { SavedQueryVisibility } from "../types/domain";
import type { ParameterSchemaEntry } from "./queryParameterParser";

const VERSION_COLUMNS = `
  id,
  saved_query_id,
  version_number,
  name,
  description,
  data_source_id,
  sql,
  default_run_params,
  parameter_schema,
  tags,
  visibility,
  change_summary,
  created_by_user_id,
  created_at
`;

export interface SavedQuerySnapshot {
  name: string;
  description: string | null;
  data_source_id: string;
  sql: string;
  default_run_params: Record<string, unknown>;
  parameter_schema: ParameterSchemaEntry[];
  tags: string[];
  visibility: SavedQueryVisibility;
}

export interface SavedQueryVersionRow {
  id: string;
  saved_query_id: string;
  version_number: number;
  name: string;
  description: string | null;
  data_source_id: string;
  sql: string;
  default_run_params: Record<string, unknown>;
  parameter_schema: ParameterSchemaEntry[];
  tags: string[];
  visibility: SavedQueryVisibility;
  change_summary: string | null;
  created_by_user_id: string | null;
  created_at: string | Date;
}

export interface RecordVersionOptions {
  actorUserId?: string | null;
  changeSummary?: string | null;
}

/**
 * Build a snapshot payload from a live saved-query row. Defensive about
 * missing/nullable fields so callers can pass either the OpenAPI shape or
 * the raw DB row.
 */
export function snapshotFromSavedQuery(savedQuery: {
  name: string;
  description?: string | null;
  data_source_id: string;
  sql: string;
  default_run_params?: Record<string, unknown> | null;
  parameter_schema?: ParameterSchemaEntry[] | null;
  tags?: string[] | null;
  visibility?: SavedQueryVisibility | null;
}): SavedQuerySnapshot {
  return {
    name: savedQuery.name,
    description: savedQuery.description ?? null,
    data_source_id: savedQuery.data_source_id,
    sql: savedQuery.sql,
    default_run_params: savedQuery.default_run_params || {},
    parameter_schema: savedQuery.parameter_schema || [],
    tags: savedQuery.tags || [],
    visibility: savedQuery.visibility || "private"
  };
}

async function nextVersionNumber(savedQueryId: string): Promise<number> {
  const result = await appDb.query<{ max_version: number | string | null }>(
    `SELECT COALESCE(MAX(version_number), 0) AS max_version
       FROM saved_query_versions
      WHERE saved_query_id = $1`,
    [savedQueryId]
  );
  return Number(result.rows[0]?.max_version ?? 0) + 1;
}

export async function recordVersion(
  savedQueryId: string,
  snapshot: SavedQuerySnapshot,
  { actorUserId = null, changeSummary = null }: RecordVersionOptions = {}
): Promise<SavedQueryVersionRow> {
  if (!isUuid(savedQueryId)) {
    throw new Error("recordVersion: savedQueryId must be a UUID");
  }
  if (!snapshot || typeof snapshot !== "object") {
    throw new Error("recordVersion: snapshot is required");
  }

  // Retry once on UNIQUE violation: two concurrent edits could both try to
  // claim the same version_number. Reading the max again and re-inserting
  // is safe because the body is identical to what we'd have written.
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const versionNumber = await nextVersionNumber(savedQueryId);
    try {
      const result = await appDb.query<SavedQueryVersionRow>(
        `
          INSERT INTO saved_query_versions (
            saved_query_id,
            version_number,
            name,
            description,
            data_source_id,
            sql,
            default_run_params,
            parameter_schema,
            tags,
            visibility,
            change_summary,
            created_by_user_id
          ) VALUES (
            $1, $2, $3, $4, $5, $6, $7::jsonb, $8::jsonb, $9::text[], $10, $11, $12
          )
          RETURNING ${VERSION_COLUMNS}
        `,
        [
          savedQueryId,
          versionNumber,
          snapshot.name,
          snapshot.description,
          snapshot.data_source_id,
          snapshot.sql,
          JSON.stringify(snapshot.default_run_params || {}),
          JSON.stringify(snapshot.parameter_schema || []),
          snapshot.tags || [],
          snapshot.visibility || "private",
          changeSummary,
          actorUserId
        ]
      );
      return result.rows[0];
    } catch (err) {
      if (isPgUniqueViolation(err) && attempt < 2) {
        // Another writer took our version_number — loop and pick the next.
        continue;
      }
      throw err;
    }
  }
  // Unreachable: the loop either returns or throws above.
  throw new Error("recordVersion: failed to claim a version_number after retries");
}

export async function listVersions(savedQueryId: string): Promise<SavedQueryVersionRow[]> {
  const result = await appDb.query<SavedQueryVersionRow>(
    `
      SELECT ${VERSION_COLUMNS}
        FROM saved_query_versions
       WHERE saved_query_id = $1
       ORDER BY version_number DESC
    `,
    [savedQueryId]
  );
  return result.rows;
}

export async function getVersionById(versionId: string): Promise<SavedQueryVersionRow | null> {
  const result = await appDb.query<SavedQueryVersionRow>(
    `SELECT ${VERSION_COLUMNS} FROM saved_query_versions WHERE id = $1`,
    [versionId]
  );
  return result.rows[0] || null;
}
