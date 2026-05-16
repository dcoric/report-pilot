-- QUERY-006: sharing and access control for saved queries.
--
-- Adds two layers of access on top of the existing `owner_id`:
--   * `visibility = 'shared'` — read-only to every authenticated user who
--     can already see the underlying data source. Owner remains the only
--     editor. Mirrors the AUTH-007 prompt_presets convention.
--   * `saved_query_shares` — explicit per-user grants with two levels:
--       'view' — recipient sees the query in their library.
--       'run'  — recipient can also execute it via /run.
--     `view` is implicit in `run`, but we store the literal level so we
--     can surface it in the UI and audit who got what.
--
-- Updating, deleting, or re-sharing a query is owner-only and continues to
-- be enforced in the service layer; this migration only adds storage.

ALTER TABLE saved_queries
  ADD COLUMN IF NOT EXISTS visibility TEXT NOT NULL DEFAULT 'private'
    CHECK (visibility IN ('private', 'shared'));

CREATE INDEX IF NOT EXISTS idx_saved_queries_visibility
  ON saved_queries (visibility, updated_at DESC)
  WHERE visibility = 'shared';

CREATE TABLE IF NOT EXISTS saved_query_shares (
  saved_query_id UUID NOT NULL REFERENCES saved_queries(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  permission TEXT NOT NULL CHECK (permission IN ('view', 'run')),
  granted_by_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (saved_query_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_saved_query_shares_user
  ON saved_query_shares (user_id);

-- Permission seed: only owners (or admins) can re-share. Viewer never gets
-- write access to authoring; they cannot redistribute someone else's work.
INSERT INTO permissions (name, description) VALUES
  ('saved_queries.share', 'Share saved queries with other users')
ON CONFLICT DO NOTHING;

WITH share_perm AS (
  SELECT id FROM permissions WHERE name = 'saved_queries.share'
)
INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, share_perm.id
  FROM roles r, share_perm
 WHERE lower(r.name) IN ('admin', 'analyst')
ON CONFLICT DO NOTHING;
