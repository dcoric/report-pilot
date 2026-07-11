// AUTH-015: covers the federation-hardening additions on top of AUTH-012.
//
// What this exercises:
//   - externalLoginService refuses to auto-link by email when the IdP
//     asserts `email_verified=false` (and the provider has the default
//     `require_email_verified=true`).
//   - externalLoginService refuses to JIT-provision when the IdP asserts
//     `email_verified=false`.
//   - When `require_email_verified=false`, the same `email_verified=false`
//     principal is allowed through (auto-linked) for ops-controlled IdPs.
//   - oidcStateService.recordUsedState returns `replayed: true` on the
//     second insertion of the same state — the in-DB unique constraint is
//     what backs replay protection.

import "./helpers/setupEnv";
import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";

process.env.DATABASE_URL = process.env.DATABASE_URL || "postgresql://test:test@localhost:5432/test";

import appDb = require("../src/lib/appDb");
import externalLoginService = require("../src/services/externalLoginService");
import oidcStateService = require("../src/services/oidcStateService");
import type { PoolClient } from "pg";
import type { ProviderRow } from "../src/services/authProviderService";
import type { AuthUserRow } from "../src/services/authService";
import type { LinkedIdentity } from "../src/services/linkedIdentityService";

interface AuditRow {
  id: string;
  actor_user_id: string | null;
  actor_email: string | null;
  target_user_id: string | null;
  action: string;
  outcome: string | null;
  details: Record<string, unknown>;
  ip_address: string | null;
  user_agent: string | null;
  created_at: string;
}

interface UsedStateRow {
  state_hash: string;
  provider_id: string;
  expires_at: Date | string;
}

let originalQuery: typeof appDb.query;
let originalWithTransaction: typeof appDb.withTransaction;

let providers: Map<string, ProviderRow>;
let users: Map<string, AuthUserRow>;
let linkedIdentities: Map<string, LinkedIdentity>;
let auditRows: AuditRow[];
let usedStates: Map<string, UsedStateRow>;
let providerCounter: number;
let userCounter: number;
let identityCounter: number;
let auditCounter: number;

function uuid(prefix: string, counter: number) {
  return `00000000-0000-4000-8000-${prefix}${String(counter).padStart(8, "0")}`;
}

function normalize(sql: string) {
  return String(sql).replace(/\s+/g, " ").trim().toLowerCase();
}

function nextProviderId(): string { providerCounter += 1; return uuid("eeee", providerCounter); }
function nextUserId(): string { userCounter += 1; return uuid("aaab", userCounter); }
function nextIdentityId(): string { identityCounter += 1; return uuid("ffff", identityCounter); }

function seedProvider(overrides: Partial<ProviderRow> = {}): ProviderRow {
  const row: ProviderRow = {
    id: overrides.id ?? nextProviderId(),
    type: "oidc",
    name: overrides.name ?? "okta",
    display_name: overrides.display_name ?? "Okta",
    issuer: overrides.issuer ?? "https://okta.example.com",
    client_id: "test-client",
    client_secret: null,
    scopes: ["openid", "email", "profile"],
    redirect_uri: "http://localhost/cb",
    claims_mapping: {},
    enabled: true,
    auto_link_by_email: overrides.auto_link_by_email ?? true,
    jit_enabled: overrides.jit_enabled ?? false,
    jit_default_role: overrides.jit_default_role ?? "viewer",
    jit_allowed_domains: overrides.jit_allowed_domains ?? [],
    require_email_verified: overrides.require_email_verified ?? true,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString()
  };
  providers.set(row.id, row);
  return row;
}

before(() => {
  originalQuery = appDb.query;
  originalWithTransaction = appDb.withTransaction;
  providers = new Map();
  users = new Map();
  linkedIdentities = new Map();
  auditRows = [];
  usedStates = new Map();
  providerCounter = 0;
  userCounter = 0;
  identityCounter = 0;
  auditCounter = 0;

  const txClient = {
    query: (sql: string, params: unknown[] = []) => appDb.query(sql, params)
  } as unknown as PoolClient;
  appDb.withTransaction = (async <T>(handler: (client: PoolClient) => Promise<T>): Promise<T> => (
    handler(txClient)
  )) as typeof appDb.withTransaction;

  appDb.query = (async (sql: string, params: unknown[] = []) => {
    const n = normalize(sql);

    if (n.startsWith("select id, email, password_hash, display_name, is_active, last_login_at, created_at, updated_at from users where lower(email) = $1")) {
      const [emailLower] = params as [string];
      const row = [...users.values()].find((u) => u.email.toLowerCase() === emailLower);
      return row ? { rowCount: 1, rows: [row] } : { rowCount: 0, rows: [] };
    }
    if (n.startsWith("select id, email, password_hash, display_name, is_active, last_login_at, created_at, updated_at from users where id = $1")) {
      const [id] = params as [string];
      const row = users.get(id);
      return row ? { rowCount: 1, rows: [row] } : { rowCount: 0, rows: [] };
    }
    if (n.startsWith("select id, user_id, provider_id, subject, email_at_link, created_at, last_seen_at from linked_identities where provider_id = $1 and subject = $2")) {
      const [providerId, subject] = params as [string, string];
      const row = [...linkedIdentities.values()].find(
        (li) => li.provider_id === providerId && li.subject === subject
      );
      return row ? { rowCount: 1, rows: [row] } : { rowCount: 0, rows: [] };
    }
    if (n.startsWith("insert into linked_identities")) {
      const [userId, providerId, subject, emailAtLink] = params as [string, string, string, string | null];
      const row: LinkedIdentity = {
        id: nextIdentityId(),
        user_id: userId, provider_id: providerId, subject, email_at_link: emailAtLink || null,
        created_at: new Date().toISOString(), last_seen_at: new Date().toISOString()
      };
      linkedIdentities.set(row.id, row);
      return { rowCount: 1, rows: [row] };
    }
    if (n.startsWith("insert into users")) {
      const [email, , displayName] = params as [string, null, string | null];
      const row: AuthUserRow = {
        id: nextUserId(), email, password_hash: null, display_name: displayName,
        is_active: true, last_login_at: null,
        created_at: new Date().toISOString(), updated_at: new Date().toISOString()
      };
      users.set(row.id, row);
      return { rowCount: 1, rows: [row] };
    }
    if (n.startsWith("select id, name from roles where lower(name) = any($1::text[])")) {
      const [names] = params as [string[]];
      return { rowCount: names.length, rows: names.map((name, idx) => ({ id: uuid("ccc1", idx + 1), name })) };
    }
    if (n.startsWith("insert into user_roles")) {
      return { rowCount: 1, rows: [{ role_id: params[1], user_id: params[0] }] };
    }
    if (n.startsWith("insert into auth_audit_log")) {
      auditCounter += 1;
      const [actorUserId, actorEmail, targetUserId, action, outcome, detailsJson, ipAddress, userAgent] = params as [
        string | null,
        string | null,
        string | null,
        string,
        string | null,
        string,
        string | null,
        string | null
      ];
      auditRows.push({
        id: uuid("dddd", auditCounter),
        actor_user_id: actorUserId, actor_email: actorEmail,
        target_user_id: targetUserId, action, outcome,
        details: JSON.parse(detailsJson) as Record<string, unknown>,
        ip_address: ipAddress, user_agent: userAgent,
        created_at: new Date().toISOString()
      });
      return { rowCount: 1, rows: [] };
    }
    // oidcStateService.recordUsedState
    if (n.startsWith("insert into oidc_used_states")) {
      const [hash, providerId, expiresAt] = params as [string, string, Date | string];
      if (usedStates.has(hash)) {
        const err = Object.assign(new Error("dup state"), { code: "23505" }); throw err;
      }
      usedStates.set(hash, { state_hash: hash, provider_id: providerId, expires_at: expiresAt });
      return { rowCount: 1, rows: [] };
    }
    // oidcStateService.pruneExpired
    if (n.startsWith("delete from oidc_used_states where expires_at < now()")) {
      return { rowCount: 0, rows: [] };
    }
    throw new Error(`Unexpected SQL in federation-hardening test stub: ${n}`);
  }) as unknown as typeof appDb.query;
});

after(() => {
  appDb.query = originalQuery;
  appDb.withTransaction = originalWithTransaction;
});

beforeEach(() => {
  providers.clear();
  users.clear();
  linkedIdentities.clear();
  auditRows.length = 0;
  usedStates.clear();
  providerCounter = 0;
  userCounter = 0;
  identityCounter = 0;
  auditCounter = 0;
});

test("auto-link by email is refused when email_verified is explicitly false", async () => {
  const provider = seedProvider();
  const userId = nextUserId();
  users.set(userId, {
    id: userId, email: "alice@example.com", password_hash: null, display_name: null,
    is_active: true, last_login_at: null,
    created_at: new Date().toISOString(), updated_at: new Date().toISOString()
  });

  const result = await externalLoginService.resolveExternalLogin(
    provider,
    {
      email: "alice@example.com",
      sub: "sub-1",
      display_name: "Alice",
      claims: { email_verified: false }
    },
    {}
  );
  assert.equal(result.ok, false);
  assert.equal(result.code, "email_unverified");
  assert.equal(result.status, 403);
  assert.ok(auditRows.some((r) => r.action === "auth.security.email_unverified"));
});

test("auto-link by email proceeds when email_verified is true", async () => {
  const provider = seedProvider();
  const userId = nextUserId();
  users.set(userId, {
    id: userId, email: "alice@example.com", password_hash: null, display_name: null,
    is_active: true, last_login_at: null,
    created_at: new Date().toISOString(), updated_at: new Date().toISOString()
  });

  const result = await externalLoginService.resolveExternalLogin(
    provider,
    {
      email: "alice@example.com",
      sub: "sub-2",
      claims: { email_verified: true }
    },
    {}
  );
  assert.equal(result.ok, true);
  assert.equal(result.mode, "linked_by_email");
});

test("JIT is refused when email_verified is explicitly false", async () => {
  const provider = seedProvider({ jit_enabled: true });
  const result = await externalLoginService.resolveExternalLogin(
    provider,
    {
      email: "new@example.com",
      sub: "sub-3",
      claims: { email_verified: false }
    },
    {}
  );
  assert.equal(result.ok, false);
  assert.equal(result.code, "email_unverified");
  assert.ok(auditRows.some((r) => r.action === "auth.security.email_unverified"));
});

test("turning require_email_verified off lets unverified emails through (ops opt-out)", async () => {
  const provider = seedProvider({ require_email_verified: false });
  const userId = nextUserId();
  users.set(userId, {
    id: userId, email: "alice@example.com", password_hash: null, display_name: null,
    is_active: true, last_login_at: null,
    created_at: new Date().toISOString(), updated_at: new Date().toISOString()
  });
  const result = await externalLoginService.resolveExternalLogin(
    provider,
    { email: "alice@example.com", sub: "sub-x", claims: { email_verified: false } },
    {}
  );
  assert.equal(result.ok, true);
  assert.equal(result.mode, "linked_by_email");
});

test("oidcStateService rejects a replayed state", async () => {
  const first = await oidcStateService.recordUsedState({
    state: "state-abc-123",
    providerId: uuid("eeee", 1),
    expiresAt: new Date(Date.now() + 60_000)
  });
  assert.equal(first.replayed, false);
  assert.equal(first.ok, true);

  const second = await oidcStateService.recordUsedState({
    state: "state-abc-123",
    providerId: uuid("eeee", 1),
    expiresAt: new Date(Date.now() + 60_000)
  });
  assert.equal(second.replayed, true);
  assert.equal(second.ok, false);
});

test("oidcStateService never persists the plaintext state value", async () => {
  await oidcStateService.recordUsedState({
    state: "raw-state-1234",
    providerId: uuid("eeee", 1),
    expiresAt: new Date(Date.now() + 60_000)
  });
  for (const row of usedStates.values()) {
    assert.notEqual(row.state_hash, "raw-state-1234", "raw state must not be stored");
    assert.match(row.state_hash, /^[a-f0-9]{64}$/);
  }
});
