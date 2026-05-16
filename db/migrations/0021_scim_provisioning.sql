-- AUTH-013: SCIM 2.0 push provisioning from upstream IdPs (Okta, Azure AD,
-- OneLogin, etc.). Two pieces:
--
-- 1. scim_tokens — long-lived bearer tokens the IdP uses to authenticate
--    against /scim/v2/* . Only the SHA-256 hash is stored; the plaintext
--    is shown to the admin exactly once at creation time. Tokens are bound
--    to an auth_providers row so we can attribute SCIM activity, revoke
--    independently of session tokens, and disable per-IdP integrations.
--
-- 2. scim_group_mappings on auth_providers — the JSON contract that
--    translates SCIM group membership into local roles. Stored as JSONB
--    `{ "<scim group displayName>": "<local role name>" }`. Empty by
--    default; populated by the admin UI when SCIM is wired up. Group
--    matching is case-insensitive at lookup time.

CREATE TABLE IF NOT EXISTS scim_tokens (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  provider_id UUID NOT NULL REFERENCES auth_providers(id) ON DELETE CASCADE,
  label TEXT NOT NULL,
  token_hash TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_used_at TIMESTAMPTZ,
  revoked_at TIMESTAMPTZ
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_scim_tokens_token_hash
  ON scim_tokens (token_hash);

CREATE INDEX IF NOT EXISTS idx_scim_tokens_provider_active
  ON scim_tokens (provider_id) WHERE revoked_at IS NULL;

ALTER TABLE auth_providers
  ADD COLUMN IF NOT EXISTS scim_group_mappings JSONB NOT NULL DEFAULT '{}'::jsonb;
