-- QUERY-008: foldering for saved queries.
--
-- Adds a per-user folder tree plus a nullable `folder_id` on `saved_queries`.
--
-- Conventions:
--   * `owner_id` mirrors the `saved_queries.owner_id` shape (TEXT). A folder
--     is private to its owner; there's no folder sharing in this milestone —
--     visibility of the *query* still drives whether someone else can see it,
--     and a shared query simply appears under its owner's folder (or at root
--     for non-owners, which is what the existing list query already returns).
--   * `parent_id` is a self-FK; NULL means the folder lives at the user's root.
--     ON DELETE SET NULL lets the service reassign children when a folder is
--     deleted (see below) without violating the FK during the cascade.
--   * `UNIQUE (owner_id, COALESCE(parent_id, '...'), lower(name))` is approximated
--     via a partial-index pair below so siblings can't collide while folders
--     under different parents (or in different roots) can share a name.
--
-- Folder-delete policy (chosen: REASSIGN):
--   When a folder is deleted, its direct children (sub-folders and saved
--   queries that point at it) are reassigned to the deleted folder's parent
--   (NULL if it was at root). This is implemented in the service layer in a
--   single transaction so the move + delete are atomic. The `ON DELETE SET NULL`
--   here is the safety net — if a row somehow slips past the service it still
--   ends up at root rather than orphaned.

CREATE TABLE IF NOT EXISTS saved_query_folders (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  owner_id TEXT NOT NULL,
  parent_id UUID REFERENCES saved_query_folders(id) ON DELETE SET NULL,
  name TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_saved_query_folders_owner
  ON saved_query_folders (owner_id);

CREATE INDEX IF NOT EXISTS idx_saved_query_folders_parent
  ON saved_query_folders (parent_id);

-- Sibling-name uniqueness, split into two partial indexes because NULL is
-- not considered equal in UNIQUE constraints. The first covers root-level
-- folders (parent IS NULL), the second covers nested folders.
CREATE UNIQUE INDEX IF NOT EXISTS idx_saved_query_folders_owner_root_name
  ON saved_query_folders (owner_id, lower(name))
  WHERE parent_id IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_saved_query_folders_owner_parent_name
  ON saved_query_folders (owner_id, parent_id, lower(name))
  WHERE parent_id IS NOT NULL;

-- Attach saved queries to a folder. NULL means "root" for that owner.
ALTER TABLE saved_queries
  ADD COLUMN IF NOT EXISTS folder_id UUID
    REFERENCES saved_query_folders(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_saved_queries_folder
  ON saved_queries (folder_id);
