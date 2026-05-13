-- AUTH-012: account linking + just-in-time (JIT) provisioning.
--
-- linked_identities stores the (provider, external subject) pairs that map an
-- IdP principal to a local user. The `subject` (OIDC `sub` claim) is the
-- stable identifier across email changes; we still record email_at_link for
-- forensics. ON DELETE CASCADE in both directions: deleting the user purges
-- their links; deleting a provider purges every link to that IdP.
--
-- The new auth_providers columns expose the JIT / linking policy per provider:
--   * auto_link_by_email — when an IdP login presents an email already
--     attached to a local user, automatically attach the external identity
--     instead of returning 403. Default ON because most production IdPs
--     verify email ownership.
--   * jit_enabled — when no local user matches, create one on the fly.
--     Default OFF (current strict behavior); the admin opts in.
--   * jit_default_role — role name (matched case-insensitively) assigned to
--     JIT-created users. Defaults to 'viewer'.
--   * jit_allowed_domains — when non-empty, only emails whose domain matches
--     (case-insensitive) are eligible for JIT.

CREATE TABLE IF NOT EXISTS linked_identities (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider_id UUID NOT NULL REFERENCES auth_providers(id) ON DELETE CASCADE,
  subject TEXT NOT NULL,
  email_at_link TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_linked_identities_provider_subject
  ON linked_identities (provider_id, subject);

CREATE INDEX IF NOT EXISTS idx_linked_identities_user
  ON linked_identities (user_id);

ALTER TABLE auth_providers
  ADD COLUMN IF NOT EXISTS auto_link_by_email BOOLEAN NOT NULL DEFAULT TRUE,
  ADD COLUMN IF NOT EXISTS jit_enabled BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS jit_default_role TEXT NOT NULL DEFAULT 'viewer',
  ADD COLUMN IF NOT EXISTS jit_allowed_domains TEXT[] NOT NULL DEFAULT ARRAY[]::text[];
