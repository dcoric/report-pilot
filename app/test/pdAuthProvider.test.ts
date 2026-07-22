import "./helpers/setupEnv";
import { test } from "node:test";
import assert from "node:assert/strict";

import { createAuthProviderService } from "../src/services/authProviders";
import type { ProviderRow } from "../src/services/authProviderService";
import appDb = require("../src/lib/appDb");
import { hashPassword, type AuthUserRow } from "../src/services/authService";

function makeProvider(): ProviderRow {
  return {
    id: "00000000-0000-4000-8000-pd0000000001",
    type: "pd",
    name: "pd-provider",
    display_name: "PD Provider",
    issuer: "pd://local",
    client_id: "",
    client_secret: "",
    scopes: [],
    redirect_uri: "http://127.0.0.1:3000/v1/auth/pd/callback",
    claims_mapping: { username: "email", email: "email", display_name: "display_name", sub: "id" },
    enabled: true,
    auto_link_by_email: true,
    jit_enabled: false,
    jit_default_role: "viewer",
    jit_allowed_domains: [],
    require_email_verified: true,
    scim_group_mappings: {},
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString()
  };
}

test("PD auth provider uses local password directory credentials instead of OIDC discovery", async () => {
  // Given: a local password-directory user with a password hash.
  const originalQuery = appDb.query;
  const user: AuthUserRow = {
    id: "00000000-0000-4000-8000-pduser000001",
    email: "alice@example.com",
    password_hash: hashPassword("alice-password"),
    display_name: "Alice PD",
    is_active: true,
    last_login_at: null,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString()
  };
  appDb.query = (async (sql: string, params: unknown[] = []) => {
    const normalized = String(sql).replace(/\s+/g, " ").trim().toLowerCase();
    if (normalized.startsWith("select id, email, password_hash, display_name, is_active, last_login_at, created_at, updated_at from users where lower(email) = $1")) {
      const [email] = params as [string];
      return email === user.email ? { rowCount: 1, rows: [user] } : { rowCount: 0, rows: [] };
    }
    if (normalized.startsWith("select count(*)::int as users from users where password_hash is not null")) {
      return { rowCount: 1, rows: [{ users: 1 }] };
    }
    return originalQuery(sql, params);
  }) as typeof appDb.query;

  try {
    const provider = makeProvider();
    const service = createAuthProviderService("pd");

    // When: login is started, credentials are completed, and the local directory is tested.
    const start = await service.startLogin(provider);
    const callback = new URL(start.authorizeUrl);
    callback.searchParams.set("username", "Alice@Example.COM");
    callback.searchParams.set("password", "alice-password");
    const complete = await service.completeLogin(provider, callback.href, start.flowState);
    const connection = await service.testConnection(provider);
    const principal = service.buildPrincipal({ id: user.id, email: "Alice@Example.COM", display_name: "Alice PD" });

    // Then: PD authenticates against the local password directory without OIDC endpoints.
    assert.equal(service.type, "pd");
    assert.doesNotMatch(start.authorizeUrl, /\/authorize\?/);
    assert.equal(start.flowState.type, "pd");
    assert.equal(start.flowState.provider_id, provider.id);
    assert.equal(complete.email, "alice@example.com");
    assert.equal(complete.display_name, "Alice PD");
    assert.equal(complete.sub, user.id);
    assert.equal(complete.username, "alice@example.com");
    assert.equal(complete.issuer, "pd://local");
    assert.equal(connection.ok, true);
    assert.equal(connection.directory, "local_password_directory");
    assert.equal(connection.password_users, 1);
    assert.equal(principal.email, "alice@example.com");
    assert.equal(principal.display_name, "Alice PD");
    assert.equal(principal.sub, user.id);
  } finally {
    appDb.query = originalQuery;
  }
});
