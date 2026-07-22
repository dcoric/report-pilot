import "./helpers/setupEnv";
import { test } from "node:test";
import assert from "node:assert/strict";

process.env.AUTH_FLOW_SECRET = process.env.AUTH_FLOW_SECRET || "x".repeat(48);

import { createMockOidcIdp } from "./helpers/mockOidcIdp";
import { createMockLdapServer } from "./helpers/mockLdapServer";
import { createMockSamlIdp } from "./helpers/mockSamlIdp";
import { createAuthProviderService } from "../src/services/authProviders";
import type { ProviderRow } from "../src/services/authProviderService";

const PROVIDER_TYPES = ["oidc", "saml", "ldap", "ad", "pd"] as const;
const OIDC_BACKED_PROVIDER_TYPES = ["oidc"] as const;
type ProviderType = (typeof PROVIDER_TYPES)[number];

function makeProvider(type: ProviderType, issuer: string, clientId: string, clientSecret: string): ProviderRow {
  return {
    id: `00000000-0000-4000-8000-${type.padEnd(12, "0")}`,
    type,
    name: `${type}-provider`,
    display_name: `${type.toUpperCase()} Provider`,
    issuer,
    client_id: clientId,
    client_secret: clientSecret,
    scopes: ["openid", "email", "profile"],
    redirect_uri: "http://127.0.0.1:3000/v1/auth/callback",
    claims_mapping: { email: "email", display_name: "name" },
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

test("OIDC-compatible auth provider types use the OIDC-backed login flow", async () => {
  const idp = await createMockOidcIdp({
    user: { sub: "user-1", email: "alice@example.com", name: "Alice" }
  });
  const issuer = await idp.start();

  try {
    for (const type of OIDC_BACKED_PROVIDER_TYPES) {
      const service = createAuthProviderService(type);
      assert.equal(service.type, type);

      const provider = makeProvider(type, issuer, idp.clientId, idp.clientSecret);
      const start = await service.startLogin(provider);
      assert.match(start.authorizeUrl, /\/authorize\?/);
      assert.equal(start.flowState.provider_id, provider.id);

      const authorizeResponse = await fetch(start.authorizeUrl, { redirect: "manual" });
      assert.equal(authorizeResponse.status, 302);
      const callback = authorizeResponse.headers.get("location");
      if (!callback) {
        throw new Error("mock authorize redirect missing location header");
      }

      const complete = await service.completeLogin(provider, callback, start.flowState);
      assert.equal(complete.email, "alice@example.com");
      assert.equal(complete.display_name, "Alice");
      assert.equal(complete.sub, "user-1");

      const principal = service.buildPrincipal({ email: "alice@example.com", sub: "user-1", name: "Alice" });
      assert.equal(principal.email, "alice@example.com");
      assert.equal(principal.sub, "user-1");
      assert.equal(principal.display_name, "Alice");

      const connection = await service.testConnection(provider);
      assert.equal(connection.ok, true);
      assert.equal(connection.issuer, issuer);
    }
  } finally {
    await idp.stop();
  }
});

test("LDAP auth provider uses bind and search instead of OIDC discovery", async () => {
  // Given: an LDAP directory with a service bind account and one user entry.
  const ldap = createMockLdapServer({
    serviceDn: "cn=report-pilot,dc=example,dc=com",
    servicePassword: "service-secret",
    usernameAttribute: "uid",
    user: {
      dn: "uid=alice,ou=people,dc=example,dc=com",
      password: "alice-password",
      attributes: {
        uid: "alice",
        mail: "Alice@Example.COM",
        cn: "Alice Directory",
        entryUUID: "ldap-user-1"
      }
    }
  });
  const issuer = await ldap.start();

  try {
    const provider = makeProvider("ldap", issuer, "cn=report-pilot,dc=example,dc=com", "service-secret");
    provider.redirect_uri = "http://127.0.0.1:3000/v1/auth/ldap/callback";
    provider.claims_mapping = {
      base_dn: "ou=people,dc=example,dc=com",
      username: "uid",
      email: "mail",
      display_name: "cn",
      sub: "entryUUID"
    };
    const service = createAuthProviderService("ldap");

    // When: login is started, credentials are completed, and the connection is tested.
    const start = await service.startLogin(provider);
    const callback = new URL(start.authorizeUrl);
    callback.searchParams.set("username", "alice");
    callback.searchParams.set("password", "alice-password");
    const complete = await service.completeLogin(provider, callback.href, start.flowState);
    const connection = await service.testConnection(provider);
    const principal = service.buildPrincipal({ mail: "Alice@Example.COM", cn: "Alice Directory", dn: "uid=alice,ou=people,dc=example,dc=com" });

    // Then: LDAP produces principals from directory attributes without an OIDC authorize URL.
    assert.equal(service.type, "ldap");
    assert.doesNotMatch(start.authorizeUrl, /\/authorize\?/);
    assert.equal(start.flowState.provider_id, provider.id);
    assert.equal(complete.email, "alice@example.com");
    assert.equal(complete.display_name, "Alice Directory");
    assert.equal(complete.sub, "ldap-user-1");
    assert.equal(complete.issuer, issuer);
    assert.equal(connection.ok, true);
    assert.equal(connection.bound, true);
    assert.equal(principal.email, "alice@example.com");
    assert.equal(principal.display_name, "Alice Directory");
    assert.equal(principal.sub, "uid=alice,ou=people,dc=example,dc=com");
  } finally {
    await ldap.stop();
  }
});

test("AD auth provider uses Active Directory LDAP bind and AD claim mapping instead of OIDC discovery", async () => {
  // Given: an Active Directory-compatible LDAP directory with service bind and AD user attributes.
  const ldap = createMockLdapServer({
    serviceDn: "cn=report-pilot,cn=users,dc=example,dc=com",
    servicePassword: "service-secret",
    usernameAttribute: "sAMAccountName",
    user: {
      dn: "cn=Alice Adams,cn=users,dc=example,dc=com",
      password: "alice-password",
      attributes: {
        sAMAccountName: "aadams",
        userPrincipalName: "aadams@example.com",
        displayName: "Alice Adams",
        mail: "Alice.Adams@Example.COM",
        objectGUID: "ad-user-1"
      }
    }
  });
  const issuer = await ldap.start();

  try {
    const provider = makeProvider("ad", issuer, "cn=report-pilot,cn=users,dc=example,dc=com", "service-secret");
    provider.redirect_uri = "http://127.0.0.1:3000/v1/auth/ad/callback";
    provider.claims_mapping = {
      base_dn: "cn=users,dc=example,dc=com",
      auth_method: "ldap_bind",
      username: "sAMAccountName",
      email: "mail",
      display_name: "displayName",
      sub: "objectGUID"
    };
    const service = createAuthProviderService("ad");

    // When: AD login is started, credentials are completed, and connection testing binds to AD over LDAP.
    const start = await service.startLogin(provider);
    const callback = new URL(start.authorizeUrl);
    callback.searchParams.set("username", "aadams");
    callback.searchParams.set("password", "alice-password");
    const complete = await service.completeLogin(provider, callback.href, start.flowState);
    const connection = await service.testConnection(provider);
    const principal = service.buildPrincipal({
      sam_account_name: "aadams",
      user_principal_name: "aadams@example.com",
      display_name: "Alice Adams",
      email: "Alice.Adams@Example.COM",
      object_guid: "ad-user-1"
    });

    // Then: AD produces principals from AD attributes without OIDC authorize or discovery endpoints.
    assert.equal(service.type, "ad");
    assert.doesNotMatch(start.authorizeUrl, /\/authorize\?/);
    assert.equal(start.flowState.type, "ad");
    assert.equal(start.flowState.provider_id, provider.id);
    assert.equal(complete.email, "alice.adams@example.com");
    assert.equal(complete.display_name, "Alice Adams");
    assert.equal(complete.sub, "ad-user-1");
    assert.equal(complete.claims.sam_account_name, "aadams");
    assert.equal(complete.claims.user_principal_name, "aadams@example.com");
    assert.equal(complete.issuer, issuer);
    assert.equal(connection.ok, true);
    assert.equal(connection.method, "ldap_bind");
    assert.equal(connection.bound, true);
    assert.deepEqual(connection.supported_methods, ["ldap_bind", "kerberos", "ntlm"]);
    assert.equal(principal.email, "alice.adams@example.com");
    assert.equal(principal.display_name, "Alice Adams");
    assert.equal(principal.sub, "ad-user-1");
    assert.equal(principal.sam_account_name, "aadams");
    assert.equal(principal.user_principal_name, "aadams@example.com");
  } finally {
    await ldap.stop();
  }
});

test("SAML auth provider uses IdP redirect and assertion claims instead of OIDC discovery", async () => {
  // Given: a SAML IdP endpoint that accepts HTTP-Redirect AuthnRequest messages.
  const idp = createMockSamlIdp({
    user: { sub: "saml-user-1", email: "Alice@Example.COM", displayName: "Alice SAML" }
  });
  const ssoUrl = await idp.start();

  try {
    const provider = makeProvider("saml", ssoUrl, "report-pilot-sp", "unused-secret");
    provider.redirect_uri = "http://127.0.0.1:3000/v1/auth/saml/acs";
    provider.claims_mapping = { email: "email", display_name: "displayName", sub: "NameID" };
    const service = createAuthProviderService("saml");

    // When: login is started, the IdP redirects back with a SAMLResponse, and the connection is tested.
    const start = await service.startLogin(provider);
    const authorizeResponse = await fetch(start.authorizeUrl, { redirect: "manual" });
    const callback = authorizeResponse.headers.get("location");
    if (!callback) {
      throw new Error("mock SAML redirect missing location header");
    }
    const complete = await service.completeLogin(provider, callback, start.flowState);
    const connection = await service.testConnection(provider);
    const principal = service.buildPrincipal({ email: "Alice@Example.COM", displayName: "Alice SAML", NameID: "saml-user-1" });

    // Then: SAML produces principals from assertion attributes without OIDC endpoints.
    assert.equal(service.type, "saml");
    assert.match(start.authorizeUrl, /SAMLRequest=/);
    assert.match(start.authorizeUrl, /RelayState=/);
    assert.doesNotMatch(start.authorizeUrl, /\/authorize\?/);
    assert.equal(start.flowState.type, "saml");
    assert.equal(start.flowState.provider_id, provider.id);
    assert.equal(authorizeResponse.status, 302);
    assert.equal(complete.email, "alice@example.com");
    assert.equal(complete.display_name, "Alice SAML");
    assert.equal(complete.sub, "saml-user-1");
    assert.equal(complete.issuer, idp.entityId);
    assert.equal(connection.ok, true);
    assert.equal(connection.sso_url, ssoUrl);
    assert.equal(principal.email, "alice@example.com");
    assert.equal(principal.display_name, "Alice SAML");
    assert.equal(principal.sub, "saml-user-1");
  } finally {
    await idp.stop();
  }
});
