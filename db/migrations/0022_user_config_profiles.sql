-- AUTH-006: per-user configuration profiles.
--
-- The shape of a config is intentionally loose so we don't need a migration
-- for every new preference. Server-side validation lives in
-- app/src/services/userConfigService.js. Today's known keys:
--   default_data_source_id   uuid  (must reference data_sources.id)
--   default_llm_provider_id  uuid  (must reference llm_providers.id, if set)
--   default_model            text
--   max_rows                 int    1..10000
--   timeout_seconds          int    1..300
--   theme                    text   "light" | "dark" | "system"
--   table_preferences        object (free-form; per-table column widths etc.)
--
-- ON DELETE CASCADE so a deleted user takes their config with them.

CREATE TABLE IF NOT EXISTS user_configs (
  user_id UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  config JSONB NOT NULL DEFAULT '{}'::jsonb,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- AUTH-006: two new permissions for the self-service GET/PUT endpoints.
-- Granted to every system role so any authenticated user can manage their
-- own preferences.
INSERT INTO permissions (name, description)
VALUES
  ('users.read_self', 'View one''s own user profile and configuration'),
  ('users.write_self', 'Update one''s own user profile and configuration')
ON CONFLICT DO NOTHING;

WITH self_perms AS (
  SELECT id FROM permissions WHERE name IN ('users.read_self', 'users.write_self')
),
system_roles AS (
  SELECT id FROM roles WHERE lower(name) IN ('admin', 'analyst', 'viewer')
)
INSERT INTO role_permissions (role_id, permission_id)
SELECT system_roles.id, self_perms.id FROM system_roles, self_perms
ON CONFLICT DO NOTHING;
