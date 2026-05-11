-- AUTH-002: User and role data model.
-- Adds roles, optional permissions, role-membership, and an audit log used to
-- record user/role lifecycle events. Seeds the three system roles
-- (admin, analyst, viewer) and an initial permission grid that AUTH-003 will
-- consume for endpoint-level enforcement.

CREATE TABLE IF NOT EXISTS roles (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  name TEXT NOT NULL,
  description TEXT,
  is_system BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_roles_name_lower
  ON roles (lower(name));

CREATE TABLE IF NOT EXISTS permissions (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  name TEXT NOT NULL,
  description TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_permissions_name
  ON permissions (name);

CREATE TABLE IF NOT EXISTS role_permissions (
  role_id UUID NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
  permission_id UUID NOT NULL REFERENCES permissions(id) ON DELETE CASCADE,
  PRIMARY KEY (role_id, permission_id)
);

CREATE TABLE IF NOT EXISTS user_roles (
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role_id UUID NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
  assigned_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  assigned_by_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  PRIMARY KEY (user_id, role_id)
);

CREATE INDEX IF NOT EXISTS idx_user_roles_role_id
  ON user_roles (role_id);

CREATE TABLE IF NOT EXISTS auth_audit_log (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  actor_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  target_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  action TEXT NOT NULL,
  details JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_auth_audit_log_target_user
  ON auth_audit_log (target_user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_auth_audit_log_action
  ON auth_audit_log (action, created_at DESC);

-- Seed system roles. ON CONFLICT against the unique lower(name) index keeps
-- this migration idempotent without depending on a UNIQUE constraint name.
INSERT INTO roles (name, description, is_system)
VALUES
  ('admin', 'Full administrative access', TRUE),
  ('analyst', 'Can query and manage saved content', TRUE),
  ('viewer', 'Read-only access', TRUE)
ON CONFLICT DO NOTHING;

-- Seed an initial permission grid. AUTH-003 will map endpoints to these names.
INSERT INTO permissions (name, description)
VALUES
  ('users.read', 'List and view users'),
  ('users.write', 'Create, update, and delete users'),
  ('roles.assign', 'Assign or revoke roles for users'),
  ('data_sources.read', 'View data sources and schemas'),
  ('data_sources.write', 'Create, update, delete data sources and import schemas'),
  ('semantic.write', 'Edit semantic entities, metrics, and join policies'),
  ('rag.write', 'Edit RAG notes and trigger reindex'),
  ('providers.read', 'View LLM provider configuration'),
  ('providers.write', 'Manage LLM provider configuration and routing'),
  ('query.run', 'Run queries against data sources'),
  ('saved_queries.read', 'View saved queries'),
  ('saved_queries.write', 'Create, update, delete saved queries'),
  ('observability.read', 'View observability metrics and release gates'),
  ('observability.write', 'Submit release-gate reports and benchmark commands')
ON CONFLICT DO NOTHING;

-- Wire role -> permissions. Admin gets everything; analyst gets read + run +
-- saved query authoring + semantic/rag edit; viewer gets read-only.
WITH all_permissions AS (
  SELECT id FROM permissions
), admin_role AS (
  SELECT id FROM roles WHERE lower(name) = 'admin'
)
INSERT INTO role_permissions (role_id, permission_id)
SELECT admin_role.id, all_permissions.id FROM admin_role, all_permissions
ON CONFLICT DO NOTHING;

WITH analyst_role AS (
  SELECT id FROM roles WHERE lower(name) = 'analyst'
), analyst_permissions AS (
  SELECT id FROM permissions WHERE name IN (
    'data_sources.read',
    'semantic.write',
    'rag.write',
    'providers.read',
    'query.run',
    'saved_queries.read',
    'saved_queries.write',
    'observability.read'
  )
)
INSERT INTO role_permissions (role_id, permission_id)
SELECT analyst_role.id, analyst_permissions.id FROM analyst_role, analyst_permissions
ON CONFLICT DO NOTHING;

WITH viewer_role AS (
  SELECT id FROM roles WHERE lower(name) = 'viewer'
), viewer_permissions AS (
  SELECT id FROM permissions WHERE name IN (
    'data_sources.read',
    'providers.read',
    'saved_queries.read',
    'observability.read'
  )
)
INSERT INTO role_permissions (role_id, permission_id)
SELECT viewer_role.id, viewer_permissions.id FROM viewer_role, viewer_permissions
ON CONFLICT DO NOTHING;
