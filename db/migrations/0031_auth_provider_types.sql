ALTER TABLE auth_providers
  DROP CONSTRAINT IF EXISTS auth_providers_type_check;

ALTER TABLE auth_providers
  ADD COLUMN IF NOT EXISTS provider_config JSONB NOT NULL DEFAULT '{}'::jsonb;

ALTER TABLE auth_providers
  ALTER COLUMN issuer DROP NOT NULL,
  ALTER COLUMN client_id DROP NOT NULL,
  ALTER COLUMN scopes DROP NOT NULL,
  ALTER COLUMN redirect_uri DROP NOT NULL,
  ALTER COLUMN claims_mapping DROP NOT NULL;

ALTER TABLE auth_providers
  ADD CONSTRAINT auth_providers_type_check
  CHECK (type IN ('oidc', 'saml', 'ldap', 'ad', 'pd'));
