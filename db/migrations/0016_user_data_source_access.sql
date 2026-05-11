-- AUTH-005: per-resource permissions. Non-admin users can only act on data
-- sources they have been explicitly granted access to. Admins bypass this
-- table at the service layer.
--
-- The seed below backfills full access for every existing non-admin user, so
-- the day-one behavior of this migration is identical to AUTH-004. New users
-- created after this migration receive no data-source access by default and
-- must be granted by an admin via /v1/admin/data-sources/{id}/access.

CREATE TABLE IF NOT EXISTS user_data_source_access (
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  data_source_id UUID NOT NULL REFERENCES data_sources(id) ON DELETE CASCADE,
  granted_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  granted_by_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  PRIMARY KEY (user_id, data_source_id)
);

CREATE INDEX IF NOT EXISTS idx_user_data_source_access_data_source
  ON user_data_source_access (data_source_id);

INSERT INTO user_data_source_access (user_id, data_source_id)
SELECT u.id, ds.id
FROM users u
CROSS JOIN data_sources ds
WHERE NOT EXISTS (
  SELECT 1
  FROM user_roles ur
  JOIN roles r ON r.id = ur.role_id
  WHERE ur.user_id = u.id AND lower(r.name) = 'admin'
)
ON CONFLICT DO NOTHING;
