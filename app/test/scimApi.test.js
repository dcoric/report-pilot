// AUTH-013: end-to-end coverage for SCIM 2.0 provisioning.
//
// What this exercises through HTTP:
//   - Bearer-token auth on /scim/v2/* — missing / unknown / revoked tokens
//     return SCIM-shaped 401s.
//   - Create user via POST /scim/v2/Users — new user, role link, audit row.
//   - Idempotency: POST with the same externalId returns 409 uniqueness.
//   - PATCH /scim/v2/Users/{id} with `replace active=false` deactivates
//     and emits `scim.user.deactivated`.
//   - Group sync via PATCH /scim/v2/Groups/{id} adds local roles to the
//     mapped members.

const { test, before, after, beforeEach } = require("node:test");
const assert = require("node:assert/strict");

process.env.DATABASE_URL = process.env.DATABASE_URL || "postgresql://test:test@localhost:5432/test";
process.env.PORT = "0";
process.env.AUTH_COOKIE_SECURE = "false";

const appDb = require("../src/lib/appDb");
const scimTokenService = require("../src/services/scimTokenService");

let server;
let baseUrl;
let originalQuery;
let originalWithTransaction;

let providers;
let users;
let linkedIdentities;
let scimTokens;
let auditRows;
let userRoleLinks; // Set of "userId:roleName"
let userCounter;
let identityCounter;
let auditCounter;
let tokenCounter;

function uuid(prefix, counter) {
  return `00000000-0000-4000-8000-${prefix}${String(counter).padStart(8, "0")}`;
}

function normalize(sql) {
  return String(sql).replace(/\s+/g, " ").trim().toLowerCase();
}

function nextUserId() { userCounter += 1; return uuid("aaab", userCounter); }
function nextIdentityId() { identityCounter += 1; return uuid("ffff", identityCounter); }
function nextAuditId() { auditCounter += 1; return uuid("dddd", auditCounter); }
function nextTokenId() { tokenCounter += 1; return uuid("9999", tokenCounter); }

function seedProvider(overrides = {}) {
  const row = {
    id: overrides.id || uuid("eeee", 1),
    type: "oidc",
    name: overrides.name || "okta",
    display_name: "Okta",
    issuer: "https://okta.example.com",
    client_id: "test-client",
    client_secret: null,
    scopes: ["openid", "email", "profile"],
    redirect_uri: "http://localhost/cb",
    claims_mapping: {},
    enabled: true,
    auto_link_by_email: true,
    jit_enabled: false,
    jit_default_role: "viewer",
    jit_allowed_domains: [],
    require_email_verified: true,
    scim_group_mappings: overrides.scim_group_mappings || {},
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString()
  };
  providers.set(row.id, row);
  return row;
}

function seedToken(providerId, { label = "okta", revoked = false } = {}) {
  const raw = scimTokenService.generateRawToken();
  const hash = scimTokenService.hashToken(raw);
  const id = nextTokenId();
  scimTokens.set(id, {
    id,
    provider_id: providerId,
    label,
    token_hash: hash,
    created_at: new Date().toISOString(),
    last_used_at: null,
    revoked_at: revoked ? new Date().toISOString() : null
  });
  return { id, token: raw };
}

async function call(method, path, { authToken, body } = {}) {
  const headers = { "Content-Type": "application/scim+json" };
  if (authToken) headers.Authorization = `Bearer ${authToken}`;
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined
  });
  let payload = null;
  const text = await response.text();
  if (text) {
    try { payload = JSON.parse(text); } catch { payload = null; }
  }
  return { status: response.status, payload };
}

before(async () => {
  originalQuery = appDb.query;
  originalWithTransaction = appDb.withTransaction;
  providers = new Map();
  users = new Map();
  linkedIdentities = new Map();
  scimTokens = new Map();
  auditRows = [];
  userRoleLinks = new Set();
  userCounter = 0;
  identityCounter = 0;
  auditCounter = 0;
  tokenCounter = 0;

  appDb.withTransaction = async (handler) => {
    const txClient = { query: async (sql, params) => appDb.query(sql, params) };
    return handler(txClient);
  };

  appDb.query = async (sql, params = []) => {
    const n = normalize(sql);

    // scimTokenService.verifyToken — SELECT by hash
    if (n.startsWith("select id, provider_id, label, token_hash, created_at, last_used_at, revoked_at from scim_tokens where token_hash = $1")) {
      const [hash] = params;
      const row = [...scimTokens.values()].find((t) => t.token_hash === hash);
      return row ? { rowCount: 1, rows: [row] } : { rowCount: 0, rows: [] };
    }
    // bump last_used_at — no-op
    if (n.startsWith("update scim_tokens set last_used_at = now() where id = $1")) {
      return { rowCount: 1, rows: [] };
    }

    // findProviderById (used by SCIM group sync)
    if (n.startsWith("select") && /from auth_providers\s+where id = \$1/.test(n)) {
      const [id] = params;
      const row = providers.get(id);
      return row ? { rowCount: 1, rows: [row] } : { rowCount: 0, rows: [] };
    }

    // scimUserService.listUsers — count + page
    if (n.startsWith("select count(*)::int as total from linked_identities li join users u on u.id = li.user_id where li.provider_id =")) {
      const [providerId] = params;
      const links = [...linkedIdentities.values()].filter((li) => li.provider_id === providerId);
      return { rowCount: 1, rows: [{ total: links.length }] };
    }
    if (n.startsWith("select u.id, u.email, u.display_name, u.is_active, u.created_at, u.updated_at, li.subject as external_id from linked_identities li join users u on u.id = li.user_id where li.provider_id =")) {
      const [providerId] = params;
      const out = [];
      for (const li of linkedIdentities.values()) {
        if (li.provider_id !== providerId) continue;
        const u = users.get(li.user_id);
        if (!u) continue;
        out.push({ ...u, external_id: li.subject });
      }
      return { rowCount: out.length, rows: out };
    }

    // scimUserService.findUserByExternalId
    if (n.startsWith("select u.id, u.email, u.password_hash, u.display_name, u.is_active, u.last_login_at, u.created_at, u.updated_at from linked_identities li join users u on u.id = li.user_id where li.provider_id = $1 and li.subject = $2")) {
      const [providerId, subject] = params;
      const link = [...linkedIdentities.values()].find(
        (li) => li.provider_id === providerId && li.subject === subject
      );
      if (!link) return { rowCount: 0, rows: [] };
      const u = users.get(link.user_id);
      return u ? { rowCount: 1, rows: [u] } : { rowCount: 0, rows: [] };
    }
    // findUserByExternalIdOrUserId (by users.id + linked_identities join)
    if (n.startsWith("select u.id, u.email, u.display_name, u.is_active, u.created_at, u.updated_at from users u join linked_identities li on li.user_id = u.id where u.id = $1 and li.provider_id = $2")) {
      const [userId, providerId] = params;
      const link = [...linkedIdentities.values()].find(
        (li) => li.user_id === userId && li.provider_id === providerId
      );
      if (!link) return { rowCount: 0, rows: [] };
      const u = users.get(userId);
      return u ? { rowCount: 1, rows: [u] } : { rowCount: 0, rows: [] };
    }

    // Lookup by lower(email) inside the SCIM create flow
    if (n.startsWith("select id, email, password_hash, display_name, is_active, last_login_at, created_at, updated_at from users where lower(email) = $1")) {
      const [emailLower] = params;
      const row = [...users.values()].find((u) => u.email.toLowerCase() === emailLower);
      return row ? { rowCount: 1, rows: [row] } : { rowCount: 0, rows: [] };
    }

    // INSERT users (SCIM create new local user)
    if (n.startsWith("insert into users")) {
      const [email, displayName, isActive] = params;
      const row = {
        id: nextUserId(),
        email,
        password_hash: null,
        display_name: displayName,
        is_active: isActive !== false,
        last_login_at: null,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString()
      };
      users.set(row.id, row);
      return { rowCount: 1, rows: [row] };
    }

    // UPDATE users (SCIM replace/patch/deactivate)
    if (n.startsWith("update users set email = $2, display_name = $3, is_active = $4, updated_at = now() where id = $1")) {
      const [id, email, displayName, isActive] = params;
      const row = users.get(id);
      if (!row) return { rowCount: 0, rows: [] };
      row.email = email;
      row.display_name = displayName;
      row.is_active = isActive;
      row.updated_at = new Date().toISOString();
      users.set(id, row);
      return { rowCount: 1, rows: [row] };
    }
    if (n.startsWith("update users set is_active = false, updated_at = now() where id = $1")) {
      const [id] = params;
      const row = users.get(id);
      if (row) { row.is_active = false; row.updated_at = new Date().toISOString(); }
      return { rowCount: row ? 1 : 0, rows: [] };
    }

    // INSERT linked_identities
    if (n.startsWith("insert into linked_identities")) {
      const [userId, providerId, subject, email] = params;
      const dup = [...linkedIdentities.values()].some(
        (li) => li.provider_id === providerId && li.subject === subject
      );
      if (dup) {
        const err = new Error("duplicate"); err.code = "23505"; throw err;
      }
      const row = {
        id: nextIdentityId(),
        user_id: userId, provider_id: providerId, subject, email_at_link: email || null,
        created_at: new Date().toISOString(), last_seen_at: new Date().toISOString()
      };
      linkedIdentities.set(row.id, row);
      return { rowCount: 1, rows: [row] };
    }
    // SELECT subject linked for user
    if (n.startsWith("select subject from linked_identities where provider_id = $1 and user_id = $2")) {
      const [providerId, userId] = params;
      const row = [...linkedIdentities.values()].find(
        (li) => li.provider_id === providerId && li.user_id === userId
      );
      return row ? { rowCount: 1, rows: [{ subject: row.subject }] } : { rowCount: 0, rows: [] };
    }
    // Unlink
    if (n.startsWith("delete from linked_identities where user_id = $1 and provider_id = $2")) {
      const [userId, providerId] = params;
      for (const [key, row] of linkedIdentities) {
        if (row.user_id === userId && row.provider_id === providerId) {
          linkedIdentities.delete(key);
          return { rowCount: 1, rows: [row] };
        }
      }
      return { rowCount: 0, rows: [] };
    }

    // roleService.assignRolesByName / revokeRolesByName
    if (n.startsWith("select id, name from roles where lower(name) = any($1::text[])")) {
      const [names] = params;
      return { rowCount: (names || []).length, rows: (names || []).map((name, idx) => ({ id: uuid("ccc1", idx + 1), name })) };
    }
    if (n.startsWith("insert into user_roles")) {
      const [userId, roleId] = params;
      const key = `${userId}:${roleId}`;
      const had = userRoleLinks.has(key);
      userRoleLinks.add(key);
      return { rowCount: had ? 0 : 1, rows: had ? [] : [{ role_id: roleId }] };
    }
    if (n.startsWith("delete from user_roles where user_id = $1 and role_id = $2 returning role_id")) {
      const [userId, roleId] = params;
      const key = `${userId}:${roleId}`;
      const had = userRoleLinks.has(key);
      userRoleLinks.delete(key);
      return { rowCount: had ? 1 : 0, rows: had ? [{ role_id: roleId }] : [] };
    }

    // Audit insert
    if (n.startsWith("insert into auth_audit_log")) {
      const [actorUserId, actorEmail, targetUserId, action, outcome, detailsJson, ipAddress, userAgent] = params;
      auditRows.push({
        id: nextAuditId(),
        actor_user_id: actorUserId, actor_email: actorEmail,
        target_user_id: targetUserId, action, outcome,
        details: JSON.parse(detailsJson),
        ip_address: ipAddress, user_agent: userAgent,
        created_at: new Date().toISOString()
      });
      return { rowCount: 1, rows: [] };
    }

    throw new Error(`Unexpected SQL in SCIM test stub: ${n}`);
  };

  delete require.cache[require.resolve("../src/server")];
  const { startServer } = require("../src/server");
  server = await startServer();
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  await new Promise((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
  appDb.query = originalQuery;
  appDb.withTransaction = originalWithTransaction;
});

beforeEach(() => {
  providers.clear();
  users.clear();
  linkedIdentities.clear();
  scimTokens.clear();
  auditRows.length = 0;
  userRoleLinks.clear();
  userCounter = 0;
  identityCounter = 0;
  auditCounter = 0;
  tokenCounter = 0;
});

test("SCIM endpoints require a bearer token", async () => {
  const noToken = await call("GET", "/scim/v2/ServiceProviderConfig");
  assert.equal(noToken.status, 401);
  assert.ok(noToken.payload && noToken.payload.schemas.includes("urn:ietf:params:scim:api:messages:2.0:Error"));

  const badToken = await call("GET", "/scim/v2/ServiceProviderConfig", { authToken: "not-a-real-token" });
  assert.equal(badToken.status, 401);
});

test("revoked tokens are rejected", async () => {
  const provider = seedProvider();
  const { token } = seedToken(provider.id, { revoked: true });
  const result = await call("GET", "/scim/v2/ServiceProviderConfig", { authToken: token });
  assert.equal(result.status, 401);
});

test("ServiceProviderConfig is bearer-authenticated and advertises PATCH support", async () => {
  const provider = seedProvider();
  const { token } = seedToken(provider.id);
  const result = await call("GET", "/scim/v2/ServiceProviderConfig", { authToken: token });
  assert.equal(result.status, 200);
  assert.equal(result.payload.patch.supported, true);
  assert.ok(Array.isArray(result.payload.authenticationSchemes));
});

test("POST /scim/v2/Users creates a local user, links the identity, and audits", async () => {
  const provider = seedProvider();
  const { token } = seedToken(provider.id);

  const result = await call("POST", "/scim/v2/Users", {
    authToken: token,
    body: {
      schemas: ["urn:ietf:params:scim:schemas:core:2.0:User"],
      userName: "alice@example.com",
      externalId: "okta-user-1",
      displayName: "Alice",
      active: true,
      emails: [{ value: "alice@example.com", primary: true }]
    }
  });
  assert.equal(result.status, 201, JSON.stringify(result.payload));
  assert.equal(result.payload.userName, "alice@example.com");
  assert.equal(result.payload.externalId, "okta-user-1");

  // Local user + link were persisted.
  const userRow = [...users.values()].find((u) => u.email === "alice@example.com");
  assert.ok(userRow, "expected user row to be created");
  const link = [...linkedIdentities.values()].find(
    (li) => li.provider_id === provider.id && li.subject === "okta-user-1"
  );
  assert.ok(link, "expected linked identity to be recorded");

  // Audit trail captures the SCIM origin.
  assert.ok(auditRows.some((r) => r.action === "scim.user.created"));
});

test("POST with the same externalId returns 409 uniqueness", async () => {
  const provider = seedProvider();
  const { token } = seedToken(provider.id);
  const body = {
    schemas: ["urn:ietf:params:scim:schemas:core:2.0:User"],
    userName: "bob@example.com",
    externalId: "okta-user-2",
    emails: [{ value: "bob@example.com", primary: true }]
  };
  const first = await call("POST", "/scim/v2/Users", { authToken: token, body });
  assert.equal(first.status, 201);
  const second = await call("POST", "/scim/v2/Users", { authToken: token, body });
  assert.equal(second.status, 409);
  assert.equal(second.payload.scimType, "uniqueness");
});

test("PATCH active=false deactivates the user and emits scim.user.deactivated", async () => {
  const provider = seedProvider();
  const { token } = seedToken(provider.id);
  const created = await call("POST", "/scim/v2/Users", {
    authToken: token,
    body: {
      schemas: ["urn:ietf:params:scim:schemas:core:2.0:User"],
      userName: "carol@example.com",
      externalId: "okta-user-3",
      active: true,
      emails: [{ value: "carol@example.com", primary: true }]
    }
  });
  assert.equal(created.status, 201);

  const patched = await call("PATCH", `/scim/v2/Users/${created.payload.id}`, {
    authToken: token,
    body: {
      schemas: ["urn:ietf:params:scim:api:messages:2.0:PatchOp"],
      Operations: [{ op: "replace", path: "active", value: false }]
    }
  });
  assert.equal(patched.status, 200);
  assert.equal(patched.payload.active, false);
  assert.ok(auditRows.some((r) => r.action === "scim.user.deactivated"));
});

test("PATCH /scim/v2/Groups syncs members to the mapped local role", async () => {
  const provider = seedProvider({ scim_group_mappings: { "Analysts": "analyst" } });
  const { token } = seedToken(provider.id);

  // Create two SCIM users so we have valid member IDs.
  const u1 = await call("POST", "/scim/v2/Users", {
    authToken: token,
    body: {
      schemas: ["urn:ietf:params:scim:schemas:core:2.0:User"],
      userName: "dan@example.com", externalId: "ext-d",
      emails: [{ value: "dan@example.com", primary: true }]
    }
  });
  const u2 = await call("POST", "/scim/v2/Users", {
    authToken: token,
    body: {
      schemas: ["urn:ietf:params:scim:schemas:core:2.0:User"],
      userName: "erin@example.com", externalId: "ext-e",
      emails: [{ value: "erin@example.com", primary: true }]
    }
  });
  assert.equal(u1.status, 201);
  assert.equal(u2.status, 201);
  const before = userRoleLinks.size;

  const result = await call("PATCH", "/scim/v2/Groups/group-1", {
    authToken: token,
    body: {
      schemas: ["urn:ietf:params:scim:api:messages:2.0:PatchOp"],
      displayName: "Analysts",
      Operations: [
        { op: "add", path: "members", value: [{ value: u1.payload.id }, { value: u2.payload.id }] }
      ]
    }
  });
  assert.equal(result.status, 200, JSON.stringify(result.payload));
  // Both users got the analyst role assigned.
  assert.equal(userRoleLinks.size - before, 2);
  assert.ok(auditRows.some((r) => r.action === "scim.group.synced"));
});

test("PATCH /scim/v2/Groups for an unmapped group is a no-op success", async () => {
  const provider = seedProvider({ scim_group_mappings: { "Engineers": "analyst" } });
  const { token } = seedToken(provider.id);
  await call("POST", "/scim/v2/Users", {
    authToken: token,
    body: { schemas: [], userName: "frank@example.com", externalId: "ext-f", emails: [{ value: "frank@example.com", primary: true }] }
  });
  const before = userRoleLinks.size;
  const result = await call("PATCH", "/scim/v2/Groups/group-2", {
    authToken: token,
    body: {
      Operations: [{ op: "add", path: "members", value: [{ value: "ext-f" }] }],
      displayName: "Sales"
    }
  });
  assert.equal(result.status, 200);
  assert.equal(userRoleLinks.size, before, "no roles should be assigned for unmapped groups");
});
