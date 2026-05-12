-- AUTH-008: extend the audit log so it can record auth lifecycle events
-- (login/logout/failed-login) in addition to the role and permission mutations
-- already tracked since AUTH-002.
--
-- New columns:
--   outcome      — 'success' | 'failure' | 'info'. Failed logins set 'failure';
--                  most mutation events default to 'success'.
--   ip_address   — client IP for the actor, when available.
--   user_agent   — client user-agent for the actor, when available.
--   actor_email  — captured for events where there is no actor_user_id row to
--                  reference (e.g. a failed login for an unknown email).
--
-- An index on created_at speeds up the default reverse-chronological listing
-- exposed by GET /v1/admin/audit-events.

ALTER TABLE auth_audit_log
  ADD COLUMN IF NOT EXISTS outcome TEXT,
  ADD COLUMN IF NOT EXISTS ip_address TEXT,
  ADD COLUMN IF NOT EXISTS user_agent TEXT,
  ADD COLUMN IF NOT EXISTS actor_email TEXT;

CREATE INDEX IF NOT EXISTS idx_auth_audit_log_created_at
  ON auth_audit_log (created_at DESC);

CREATE INDEX IF NOT EXISTS idx_auth_audit_log_actor_user
  ON auth_audit_log (actor_user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_auth_audit_log_outcome
  ON auth_audit_log (outcome, created_at DESC);
