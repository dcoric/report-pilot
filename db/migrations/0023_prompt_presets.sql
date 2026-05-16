-- AUTH-007: per-user prompt preset library.
--
-- A prompt preset is a saved natural-language question the user can reload
-- into the query workspace. Each preset is owned by exactly one user; the
-- `visibility` column controls whether other users see it on their list:
--   'private' (default) — only the owner sees it.
--   'shared'            — visible read-only to every authenticated user;
--                         only the owner can edit / delete it.
--
-- `data_source_id` is optional: presets may be scoped to a specific data
-- source ("month-end revenue by region") or generic ("what tables relate
-- to customers?"). When set we FK to data_sources with ON DELETE SET NULL
-- so a deleted data source doesn't orphan the preset.

CREATE TABLE IF NOT EXISTS prompt_presets (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  owner_user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  prompt_text TEXT NOT NULL,
  data_source_id UUID REFERENCES data_sources(id) ON DELETE SET NULL,
  tags TEXT[] NOT NULL DEFAULT ARRAY[]::text[],
  visibility TEXT NOT NULL DEFAULT 'private'
    CHECK (visibility IN ('private', 'shared')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_prompt_presets_owner
  ON prompt_presets (owner_user_id, created_at DESC);

-- Shared listing is hot path: the WHERE clause in the API filters by
-- visibility = 'shared' first to surface other users' presets.
CREATE INDEX IF NOT EXISTS idx_prompt_presets_shared
  ON prompt_presets (visibility, created_at DESC)
  WHERE visibility = 'shared';
