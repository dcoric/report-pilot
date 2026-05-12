-- AUTH-010: external auth provider configuration. Today this stores OIDC
-- providers; AUTH-011 will reuse the same table for SAML and LDAP rows
-- (distinguished by `type`).
--
-- `client_secret` is stored plaintext for now and redacted by the admin API.
-- Encryption-at-rest is intentionally out-of-scope here and tracked as a
-- follow-up; deployments that care should encrypt the column via PG TDE,
-- pgcrypto, or by writing through an encrypting service.

CREATE TABLE IF NOT EXISTS auth_providers (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  type TEXT NOT NULL CHECK (type IN ('oidc')),
  name TEXT NOT NULL,
  display_name TEXT,
  issuer TEXT NOT NULL,
  client_id TEXT NOT NULL,
  client_secret TEXT,
  scopes TEXT[] NOT NULL DEFAULT ARRAY['openid', 'email', 'profile']::text[],
  redirect_uri TEXT NOT NULL,
  claims_mapping JSONB NOT NULL DEFAULT '{}'::jsonb,
  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_auth_providers_name_lower
  ON auth_providers (lower(name));

CREATE INDEX IF NOT EXISTS idx_auth_providers_enabled
  ON auth_providers (enabled);
