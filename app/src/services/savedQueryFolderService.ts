// QUERY-008: folder organisation for saved reports.
//
// Folders are per-owner; non-owners do not see them (a saved query shared
// org-wide still appears in the recipient's library via the existing
// list query — it just isn't filed under the recipient's folder tree).
//
// Hierarchy rules enforced here:
//   * parent_id must belong to the same owner.
//   * A folder cannot be its own parent.
//   * Moving a folder into one of its own descendants is rejected.
//   * Sibling-name collisions (case-insensitive) are rejected with 409.
//   * Folder depth is capped at MAX_FOLDER_DEPTH to keep the sidebar shallow.
//
// Folder-delete policy (chosen: REASSIGN):
//   When a folder is deleted, its direct children — both child folders and
//   any saved queries that pointed at it — are reparented to the deleted
//   folder's parent (NULL if it was a root folder). The reparent + delete
//   happen in a single transaction so the move is atomic.

import appDb = require("../lib/appDb");
import { isUuid, isPgUniqueViolation } from "../lib/validation";

export const FOLDER_NAME_MAX_LENGTH = 120 as const;
export const MAX_FOLDER_DEPTH = 10 as const;

const FOLDER_COLUMNS = `
  id,
  owner_id,
  parent_id,
  name,
  created_at,
  updated_at
`;

export interface FolderRow {
  id: string;
  owner_id: string;
  parent_id: string | null;
  name: string;
  created_at: string | Date;
  updated_at: string | Date;
}

interface FolderNode extends FolderRow {
  children: FolderNode[];
}

export interface ServiceSuccess<T> {
  ok: true;
  statusCode: number;
  body: T;
}
export interface ServiceFailure<T = unknown> {
  ok: false;
  statusCode: number;
  body: T;
}
export type ServiceResult<TSuccess, TFailure = unknown> = ServiceSuccess<TSuccess> | ServiceFailure<TFailure>;

interface ErrorBody {
  error: string;
  message?: string;
}

function success<T>(body: T, statusCode = 200): ServiceSuccess<T> {
  return { ok: true, statusCode, body };
}

function failure<T>(statusCode: number, body: T): ServiceFailure<T> {
  return { ok: false, statusCode, body };
}

function normalizeName(value: unknown): string {
  if (typeof value !== "string") return "";
  return value.trim();
}

type ParentIdValidation = { ok: true; value: string | null | undefined } | { ok: false; message: string };

function normalizeParentId(value: unknown): ParentIdValidation {
  if (value === undefined) return { ok: true, value: undefined };
  if (value === null) return { ok: true, value: null };
  if (typeof value === "string" && value.trim() === "") return { ok: true, value: null };
  if (typeof value !== "string" || !isUuid(value)) {
    return { ok: false, message: "parent_id must be a UUID or null" };
  }
  return { ok: true, value };
}

async function loadFolder(folderId: string): Promise<FolderRow | null> {
  if (!isUuid(folderId)) return null;
  const result = await appDb.query<FolderRow>(
    `SELECT ${FOLDER_COLUMNS} FROM saved_query_folders WHERE id = $1`,
    [folderId]
  );
  return result.rows[0] || null;
}

// Returns the path from root → folder as an array of ids (inclusive).
// Used both for depth checking and cycle detection on move.
async function loadAncestorChain(folderId: string): Promise<string[]> {
  if (!isUuid(folderId)) return [];
  const result = await appDb.query<{ id: string }>(
    `
      WITH RECURSIVE chain AS (
        SELECT id, parent_id, 1 AS depth
          FROM saved_query_folders
         WHERE id = $1
        UNION ALL
        SELECT f.id, f.parent_id, c.depth + 1
          FROM saved_query_folders f
          JOIN chain c ON c.parent_id = f.id
         WHERE c.depth < $2
      )
      SELECT id FROM chain
    `,
    [folderId, MAX_FOLDER_DEPTH + 1]
  );
  // Result is leaf-first; return as-is (callers only care about membership + length).
  return result.rows.map((row) => row.id);
}

async function isDescendantOf(candidateId: string, ancestorId: string): Promise<boolean> {
  // True if `candidateId` lives somewhere under `ancestorId`.
  if (!isUuid(candidateId) || !isUuid(ancestorId)) return false;
  if (candidateId === ancestorId) return true;
  const result = await appDb.query(
    `
      WITH RECURSIVE subtree AS (
        SELECT id FROM saved_query_folders WHERE id = $1
        UNION ALL
        SELECT f.id FROM saved_query_folders f
          JOIN subtree s ON f.parent_id = s.id
      )
      SELECT 1 FROM subtree WHERE id = $2 LIMIT 1
    `,
    [ancestorId, candidateId]
  );
  return result.rowCount! > 0;
}

type ParentCheck =
  | { ok: true; value: string | null }
  | { ok: false; statusCode: number; message: string };

async function validateParent(
  ownerId: string,
  parentId: string | null | undefined,
  { folderBeingMoved = null }: { folderBeingMoved?: string | null } = {}
): Promise<ParentCheck> {
  if (parentId === null || parentId === undefined) {
    return { ok: true, value: null };
  }
  const parent = await loadFolder(parentId);
  if (!parent) {
    return { ok: false, statusCode: 404, message: "parent_id folder not found" };
  }
  if (parent.owner_id !== ownerId) {
    return { ok: false, statusCode: 403, message: "parent_id belongs to another owner" };
  }
  if (folderBeingMoved) {
    if (parent.id === folderBeingMoved) {
      return { ok: false, statusCode: 400, message: "A folder cannot be its own parent" };
    }
    // Reject moves into the folder's own subtree to prevent cycles.
    if (await isDescendantOf(parent.id, folderBeingMoved)) {
      return {
        ok: false,
        statusCode: 400,
        message: "Cannot move a folder under one of its own descendants"
      };
    }
  }
  // Depth guard: chain length to root + 1 (for the new folder) must not
  // exceed the cap.
  const ancestors = await loadAncestorChain(parent.id);
  if (ancestors.length >= MAX_FOLDER_DEPTH) {
    return {
      ok: false,
      statusCode: 400,
      message: `Folder depth cannot exceed ${MAX_FOLDER_DEPTH}`
    };
  }
  return { ok: true, value: parent.id };
}

export interface CreateFolderInput {
  ownerId: string | null | undefined;
  name: unknown;
  parentId?: unknown;
}

export async function createFolder({ ownerId, name, parentId }: CreateFolderInput): Promise<ServiceResult<FolderRow, ErrorBody>> {
  const ownerTrimmed = String(ownerId || "").trim();
  if (!ownerTrimmed) {
    return failure(401, { error: "unauthenticated" });
  }
  const folderName = normalizeName(name);
  if (!folderName) {
    return failure(400, { error: "bad_request", message: "name is required" });
  }
  if (folderName.length > FOLDER_NAME_MAX_LENGTH) {
    return failure(400, {
      error: "bad_request",
      message: `name cannot exceed ${FOLDER_NAME_MAX_LENGTH} characters`
    });
  }
  const parentValidation = normalizeParentId(parentId);
  if (parentValidation.ok !== true) {
    return failure(400, { error: "bad_request", message: parentValidation.message });
  }
  const parentCheck = await validateParent(ownerTrimmed, parentValidation.value);
  if (parentCheck.ok !== true) {
    return failure(parentCheck.statusCode, { error: "bad_request", message: parentCheck.message });
  }

  try {
    const insertResult = await appDb.query<FolderRow>(
      `
        INSERT INTO saved_query_folders (owner_id, parent_id, name)
        VALUES ($1, $2, $3)
        RETURNING ${FOLDER_COLUMNS}
      `,
      [ownerTrimmed, parentCheck.value, folderName]
    );
    return success(insertResult.rows[0], 201);
  } catch (err) {
    if (isPgUniqueViolation(err)) {
      return failure(409, {
        error: "conflict",
        message: "A folder with that name already exists at this level"
      });
    }
    throw err;
  }
}

export interface ListFoldersResult {
  items: FolderRow[];
  tree: FolderNode[];
}

export async function listFolders({ ownerId }: { ownerId: string | null | undefined }): Promise<ServiceResult<ListFoldersResult, ErrorBody>> {
  const ownerTrimmed = String(ownerId || "").trim();
  if (!ownerTrimmed) {
    return failure(401, { error: "unauthenticated" });
  }
  const result = await appDb.query<FolderRow>(
    `
      SELECT ${FOLDER_COLUMNS}
        FROM saved_query_folders
       WHERE owner_id = $1
       ORDER BY (parent_id IS NULL) DESC, lower(name) ASC
    `,
    [ownerTrimmed]
  );
  const rows = result.rows;

  // Tree shape: same rows, nested for callers (sidebar) that want a ready
  // tree. Each node carries a `children` array of folder nodes. Saved-query
  // membership lives on the saved-queries response (`folder_id`), so the
  // sidebar can join them in a single render pass.
  const byId = new Map<string, FolderNode>();
  for (const row of rows) {
    byId.set(row.id, { ...row, children: [] });
  }
  const tree: FolderNode[] = [];
  for (const row of rows) {
    const node = byId.get(row.id)!;
    if (row.parent_id && byId.has(row.parent_id)) {
      byId.get(row.parent_id)!.children.push(node);
    } else {
      tree.push(node);
    }
  }

  return success({ items: rows, tree });
}

export interface UpdateFolderInput {
  ownerId: string | null | undefined;
  name?: unknown;
  parentId?: unknown;
}

export async function updateFolder(folderId: string, { ownerId, name, parentId }: UpdateFolderInput): Promise<ServiceResult<FolderRow, ErrorBody>> {
  if (!isUuid(folderId)) {
    return failure(400, { error: "bad_request", message: "folderId must be a valid UUID" });
  }
  const ownerTrimmed = String(ownerId || "").trim();
  if (!ownerTrimmed) {
    return failure(401, { error: "unauthenticated" });
  }
  const existing = await loadFolder(folderId);
  if (!existing) {
    return failure(404, { error: "not_found", message: "Folder not found" });
  }
  if (existing.owner_id !== ownerTrimmed) {
    return failure(403, { error: "forbidden", message: "Only the owner can update this folder" });
  }

  let nextName = existing.name;
  if (name !== undefined) {
    nextName = normalizeName(name);
    if (!nextName) {
      return failure(400, { error: "bad_request", message: "name cannot be empty" });
    }
    if (nextName.length > FOLDER_NAME_MAX_LENGTH) {
      return failure(400, {
        error: "bad_request",
        message: `name cannot exceed ${FOLDER_NAME_MAX_LENGTH} characters`
      });
    }
  }

  let nextParentId = existing.parent_id;
  if (parentId !== undefined) {
    const parentValidation = normalizeParentId(parentId);
    if (parentValidation.ok !== true) {
      return failure(400, { error: "bad_request", message: parentValidation.message });
    }
    const parentCheck = await validateParent(ownerTrimmed, parentValidation.value, {
      folderBeingMoved: folderId
    });
    if (parentCheck.ok !== true) {
      return failure(parentCheck.statusCode, { error: "bad_request", message: parentCheck.message });
    }
    nextParentId = parentCheck.value;
  }

  try {
    const updateResult = await appDb.query<FolderRow>(
      `
        UPDATE saved_query_folders
           SET name = $2,
               parent_id = $3,
               updated_at = NOW()
         WHERE id = $1
         RETURNING ${FOLDER_COLUMNS}
      `,
      [folderId, nextName, nextParentId]
    );
    if (updateResult.rowCount === 0) {
      return failure(404, { error: "not_found", message: "Folder not found" });
    }
    return success(updateResult.rows[0]);
  } catch (err) {
    if (isPgUniqueViolation(err)) {
      return failure(409, {
        error: "conflict",
        message: "A folder with that name already exists at this level"
      });
    }
    throw err;
  }
}

export interface DeleteFolderResult {
  ok: true;
  id: string;
  reassigned_to: string | null;
  reassigned_folder_ids: string[];
  reassigned_saved_query_ids: string[];
}

export async function deleteFolder(folderId: string, { ownerId }: { ownerId: string | null | undefined }): Promise<ServiceResult<DeleteFolderResult, ErrorBody>> {
  if (!isUuid(folderId)) {
    return failure(400, { error: "bad_request", message: "folderId must be a valid UUID" });
  }
  const ownerTrimmed = String(ownerId || "").trim();
  if (!ownerTrimmed) {
    return failure(401, { error: "unauthenticated" });
  }
  const existing = await loadFolder(folderId);
  if (!existing) {
    return failure(404, { error: "not_found", message: "Folder not found" });
  }
  if (existing.owner_id !== ownerTrimmed) {
    return failure(403, { error: "forbidden", message: "Only the owner can delete this folder" });
  }

  // REASSIGN policy: reparent direct children (sub-folders + saved queries)
  // to the deleted folder's parent, then delete the folder itself. Done in
  // a single transaction so a partial failure doesn't leave the tree
  // half-rewritten.
  const reassignedTo = existing.parent_id; // may be null (root)
  const summary = await appDb.withTransaction(async (client) => {
    const childFolders = await client.query<{ id: string }>(
      `
        UPDATE saved_query_folders
           SET parent_id = $2,
               updated_at = NOW()
         WHERE parent_id = $1
         RETURNING id
      `,
      [folderId, reassignedTo]
    );
    const childQueries = await client.query<{ id: string }>(
      `
        UPDATE saved_queries
           SET folder_id = $2,
               updated_at = NOW()
         WHERE folder_id = $1
         RETURNING id
      `,
      [folderId, reassignedTo]
    );
    await client.query(
      `DELETE FROM saved_query_folders WHERE id = $1`,
      [folderId]
    );
    return {
      reassigned_to: reassignedTo,
      reassigned_folder_ids: childFolders.rows.map((row) => row.id),
      reassigned_saved_query_ids: childQueries.rows.map((row) => row.id)
    };
  });

  return success({ ok: true as const, id: folderId, ...summary });
}

export interface MoveSavedQueryInput {
  ownerId: string | null | undefined;
  folderId: unknown;
}

export interface MoveSavedQueryResult {
  saved_query: unknown;
  previous_folder_id: string | null;
  folder_id: string | null;
}

// QUERY-008: move a saved query into a folder (or to root). Returns the
// updated saved-query row plus the resolved folder reference so the sidebar
// tree can patch state without a follow-up GET.
export async function moveSavedQuery(savedQueryId: string, { ownerId, folderId }: MoveSavedQueryInput): Promise<ServiceResult<MoveSavedQueryResult, ErrorBody>> {
  if (!isUuid(savedQueryId)) {
    return failure(400, { error: "bad_request", message: "savedQueryId must be a valid UUID" });
  }
  const ownerTrimmed = String(ownerId || "").trim();
  if (!ownerTrimmed) {
    return failure(401, { error: "unauthenticated" });
  }
  const folderValidation = normalizeParentId(folderId);
  if (folderValidation.ok !== true) {
    return failure(400, { error: "bad_request", message: folderValidation.message.replace("parent_id", "folder_id") });
  }

  // Load the saved query and verify ownership. Folders are per-owner so a
  // recipient of a share grant cannot relocate someone else's query.
  const queryRow = await appDb.query<{ id: string; owner_id: string; folder_id: string | null }>(
    `SELECT id, owner_id, folder_id FROM saved_queries WHERE id = $1`,
    [savedQueryId]
  );
  if (queryRow.rowCount === 0) {
    return failure(404, { error: "not_found", message: "Saved query not found" });
  }
  const savedQuery = queryRow.rows[0];
  if (savedQuery.owner_id !== ownerTrimmed) {
    return failure(403, { error: "forbidden", message: "Only the owner can move this saved query" });
  }

  let resolvedFolderId: string | null = null;
  if (folderValidation.value) {
    const folder = await loadFolder(folderValidation.value);
    if (!folder) {
      return failure(404, { error: "not_found", message: "folder_id not found" });
    }
    if (folder.owner_id !== ownerTrimmed) {
      return failure(403, { error: "forbidden", message: "folder_id belongs to another owner" });
    }
    resolvedFolderId = folder.id;
  }

  const updateResult = await appDb.query(
    `
      UPDATE saved_queries
         SET folder_id = $2,
             updated_at = NOW()
       WHERE id = $1
       RETURNING
         id,
         owner_id,
         name,
         description,
         data_source_id,
         sql,
         default_run_params,
         parameter_schema,
         tags,
         visibility,
         folder_id,
         created_at,
         updated_at
    `,
    [savedQueryId, resolvedFolderId]
  );

  return success({
    saved_query: updateResult.rows[0],
    previous_folder_id: savedQuery.folder_id || null,
    folder_id: resolvedFolderId
  });
}
