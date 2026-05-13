-- AUTH-015: harden the external-IdP login path.
--
-- 1. oidc_used_states — replay protection for the OIDC authorization code
--    flow. The state value from a callback is hashed and stored here once
--    it's been consumed (whether the callback succeeded or failed). A second
--    callback that arrives with the same state is rejected before it ever
--    reaches the token-exchange step, even if the signed flow cookie is
--    intact and within its 10-minute TTL.
--
--    The hash is SHA-256 of the raw state value so the table never stores
--    the plaintext that the IdP and the user's browser saw. expires_at is
--    derived from the flow cookie's TTL plus a small grace window; a small
--    sweep query at write time prunes rows past their expiry so the table
--    stays bounded.
--
-- 2. require_email_verified on auth_providers — when true (the default),
--    a successful OIDC token whose `email_verified` claim is explicitly
--    `false` will NOT be allowed to auto-link to an existing local user by
--    email. Linking by subject is still permitted (the IdP has already
--    attested that this principal owns the account). This closes the
--    primary vector against the auto-link path that AUTH-012 introduced.

CREATE TABLE IF NOT EXISTS oidc_used_states (
  state_hash TEXT PRIMARY KEY,
  provider_id UUID REFERENCES auth_providers(id) ON DELETE CASCADE,
  used_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at TIMESTAMPTZ NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_oidc_used_states_expires_at
  ON oidc_used_states (expires_at);

ALTER TABLE auth_providers
  ADD COLUMN IF NOT EXISTS require_email_verified BOOLEAN NOT NULL DEFAULT TRUE;
