import "./helpers/setupEnv";
import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";

process.env.DATABASE_URL = process.env.DATABASE_URL || "postgresql://test:test@localhost:5432/test";
process.env.PORT = "0";
process.env.AUTH_COOKIE_SECURE = "false";

import appDb = require("../src/lib/appDb");
import authService = require("../src/services/authService");

const SYSTEM_ROLES = ["admin", "analyst", "viewer"];

let server: import("http").Server;
let baseUrl: string;
let users;
let sessions;
let roles;
let userRoles;
let auditLog;
let userCounter;
let sessionCounter;
let roleCounter;
let originalQuery: typeof appDb.query;
let originalWithTransaction: typeof appDb.withTransaction;

function uuid(prefix: string, counter: number) {
  return `00000000-0000-4000-8000-${prefix}${String(counter).padStart(8, "0")}`;
}

function nextUserId(): string {
  userCounter += 1;
  return uuid("aaaa", userCounter);
}

function nextSessionId() {
  sessionCounter += 1;
  return uuid("bbbb", sessionCounter);
}

function nextRoleId() {
  roleCounter += 1;
  return uuid("cccc", roleCounter);
}

function normalizeSql(sql) {
  return String(sql).replace(/\s+/g, " ").trim().toLowerCase();
}

function seedSystemRoles() {
  for (const name of SYSTEM_ROLES) {
    roles.set(name, {
      id: nextRoleId(),
      name,
      description: `${name} role`,
      is_system: true,
      created_at: new Date().toISOString()
    });
  }
}

function seedUser({ email, password, displayName = null, isActive = true, roleNames = [] }) {
  const row = {
    id: nextUserId(),
    email,
    password_hash: authService.hashPassword(password),
    display_name: displayName,
    is_active: isActive,
    last_login_at: null,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString()
  };
  users.set(row.id, row);
  for (const name of roleNames) {
    const role = roles.get(name);
    assert.ok(role, `seed role ${name} must exist`);
    userRoles.set(`${row.id}:${role.id}`, {
      user_id: row.id,
      role_id: role.id,
      assigned_at: new Date().toISOString(),
      assigned_by_user_id: null
    });
  }
  return row;
}

function seedSession(userId, { expiresInMs = 60 * 60 * 1000 } = {}) {
  const token = authService.generateSessionToken();
  const tokenHash = authService.hashSessionToken(token);
  const expiresAt = new Date(Date.now() + expiresInMs).toISOString();
  const row = {
    id: nextSessionId(),
    user_id: userId,
    token_hash: tokenHash,
    user_agent: null,
    ip_address: null,
    created_at: new Date().toISOString(),
    expires_at: expiresAt,
    last_seen_at: new Date().toISOString(),
    revoked_at: null
  };
  sessions.set(row.id, row);
  return { token, sessionId: row.id, expiresAt };
}

function rolesForUser(userId) {
  const names = [];
  for (const link of userRoles.values()) {
    if (link.user_id !== userId) continue;
    for (const role of roles.values()) {
      if (role.id === link.role_id) {
        names.push(role.name);
        break;
      }
    }
  }
  return names.sort();
}

function duplicateEmailError() {
  const err = new Error("duplicate key value violates unique constraint");
  (err as { code?: string }).code = "23505";
  return err;
}

async function runQuery(sql, params = []) {
  const normalized = normalizeSql(sql);

  // --- authService.findActiveSession
  if (normalized.startsWith(
    "select s.id as session_id, s.expires_at, s.revoked_at, u.id, u.email, u.password_hash, u.display_name, u.is_active, u.last_login_at, u.created_at, u.updated_at from user_sessions s join users u on u.id = s.user_id where s.token_hash = $1"
  )) {
    const [tokenHash] = params;
    const session = [...sessions.values()].find((entry) => entry.token_hash === tokenHash);
    if (!session) return { rowCount: 0, rows: [] };
    const user = users.get(session.user_id);
    if (!user) return { rowCount: 0, rows: [] };
    return {
      rowCount: 1,
      rows: [{
        session_id: session.id,
        expires_at: session.expires_at,
        revoked_at: session.revoked_at,
        id: user.id,
        email: user.email,
        password_hash: user.password_hash,
        display_name: user.display_name,
        is_active: user.is_active,
        last_login_at: user.last_login_at,
        created_at: user.created_at,
        updated_at: user.updated_at
      }]
    };
  }

  // --- authService.touchSession
  if (normalized.startsWith("update user_sessions set last_seen_at = now() where id = $1")) {
    return { rowCount: 1, rows: [] };
  }

  // --- roleService.listRolesForUser
  if (normalized.startsWith(
    "select r.id, r.name, r.description, r.is_system, ur.assigned_at from user_roles ur join roles r on r.id = ur.role_id where ur.user_id = $1 order by r.name"
  )) {
    const [userId] = params;
    const rows = [];
    for (const link of userRoles.values()) {
      if (link.user_id !== userId) continue;
      for (const role of roles.values()) {
        if (role.id === link.role_id) {
          rows.push({
            id: role.id,
            name: role.name,
            description: role.description,
            is_system: role.is_system,
            assigned_at: link.assigned_at
          });
          break;
        }
      }
    }
    rows.sort((a, b) => a.name.localeCompare(b.name));
    return { rowCount: rows.length, rows };
  }

  // --- adminUserService.listUsers
  if (normalized.startsWith(
    "select u.id, u.email, u.display_name, u.is_active, u.last_login_at, u.created_at, u.updated_at, coalesce( ( select array_agg(r.name order by r.name) from user_roles ur join roles r on r.id = ur.role_id where ur.user_id = u.id ), array[]::text[] ) as roles from users u order by lower(u.email)"
  )) {
    const sorted = [...users.values()].sort((a, b) => a.email.localeCompare(b.email));
    const rows = sorted.map((u) => ({
      id: u.id,
      email: u.email,
      display_name: u.display_name,
      is_active: u.is_active,
      last_login_at: u.last_login_at,
      created_at: u.created_at,
      updated_at: u.updated_at,
      roles: rolesForUser(u.id)
    }));
    return { rowCount: rows.length, rows };
  }

  // --- adminUserService.updateUserRoles user lookup
  if (normalized.startsWith(
    "select id, email, display_name, is_active, last_login_at, created_at, updated_at from users where id = $1"
  )) {
    const [id] = params;
    const u = users.get(id);
    return u
      ? { rowCount: 1, rows: [{
          id: u.id,
          email: u.email,
          display_name: u.display_name,
          is_active: u.is_active,
          last_login_at: u.last_login_at,
          created_at: u.created_at,
          updated_at: u.updated_at
        }] }
      : { rowCount: 0, rows: [] };
  }

  // --- adminUserService.createUser insert
  if (normalized.startsWith("insert into users")) {
    const [email, passwordHash, displayName] = params;
    const dup = [...users.values()].some((u) => u.email.toLowerCase() === email.toLowerCase());
    if (dup) {
      throw duplicateEmailError();
    }
    const row = {
      id: nextUserId(),
      email,
      password_hash: passwordHash,
      display_name: displayName,
      is_active: true,
      last_login_at: null,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    };
    users.set(row.id, row);
    return {
      rowCount: 1,
      rows: [{
        id: row.id,
        email: row.email,
        display_name: row.display_name,
        is_active: row.is_active,
        last_login_at: row.last_login_at,
        created_at: row.created_at,
        updated_at: row.updated_at
      }]
    };
  }

  // --- roleService.assignRolesByName / revokeRolesByName lookup
  if (normalized.startsWith("select id, name from roles where lower(name) = any($1::text[])")) {
    const [names] = params;
    const rows = [];
    for (const role of roles.values()) {
      if (names.includes(role.name)) {
        rows.push({ id: role.id, name: role.name });
      }
    }
    return { rowCount: rows.length, rows };
  }

  // --- roleService.assignRolesByName insert
  if (normalized.startsWith(
    "insert into user_roles (user_id, role_id, assigned_by_user_id) values ($1, $2, $3) on conflict (user_id, role_id) do nothing returning role_id"
  )) {
    const [userId, roleId, actorUserId] = params;
    const key = `${userId}:${roleId}`;
    if (userRoles.has(key)) {
      return { rowCount: 0, rows: [] };
    }
    userRoles.set(key, {
      user_id: userId,
      role_id: roleId,
      assigned_at: new Date().toISOString(),
      assigned_by_user_id: actorUserId
    });
    return { rowCount: 1, rows: [{ role_id: roleId }] };
  }

  // --- roleService.revokeRolesByName delete
  if (normalized.startsWith("delete from user_roles where user_id = $1 and role_id = $2 returning role_id")) {
    const [userId, roleId] = params;
    const key = `${userId}:${roleId}`;
    if (!userRoles.has(key)) {
      return { rowCount: 0, rows: [] };
    }
    userRoles.delete(key);
    return { rowCount: 1, rows: [{ role_id: roleId }] };
  }

  // --- auditService.writeEvent / roleService.writeAuditEntry
  if (normalized.startsWith("insert into auth_audit_log")) {
    // AUTH-008 expanded the columns to: actor_user_id, actor_email,
    // target_user_id, action, outcome, details, ip_address, user_agent.
    const [actorUserId, actorEmail, targetUserId, action, outcome, detailsJson, ipAddress, userAgent] = params;
    auditLog.push({
      actor_user_id: actorUserId,
      actor_email: actorEmail,
      target_user_id: targetUserId,
      action,
      outcome,
      details: JSON.parse(detailsJson),
      ip_address: ipAddress,
      user_agent: userAgent,
      created_at: new Date().toISOString()
    });
    return { rowCount: 1, rows: [] };
  }

  throw new Error(`Unexpected SQL in admin test stub: ${normalized}`);
}

async function api(method: string, path: string, body?: unknown, { cookie }: { cookie?: string } = {}) {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (cookie) headers.Cookie = cookie;
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined
  });
  let payload = null;
  try {
    payload = await response.json();
  } catch {
    payload = null;
  }
  return { status: response.status, payload };
}

function cookieFor(token) {
  return `rp_session=${encodeURIComponent(token)}`;
}

before(async () => {
  originalQuery = appDb.query;
  originalWithTransaction = appDb.withTransaction;
  users = new Map();
  sessions = new Map();
  roles = new Map();
  userRoles = new Map();
  auditLog = [];
  userCounter = 0;
  sessionCounter = 0;
  roleCounter = 0;

  appDb.query = ((sql: string, params: unknown[] = []) => runQuery(sql, params)) as unknown as typeof appDb.query;
  appDb.withTransaction = (async (handler) => {
    return handler({ query: (sql: string, params: unknown[] = []) => runQuery(sql, params) } as unknown as Parameters<typeof appDb.withTransaction>[0] extends (c: infer C) => unknown ? C : never);
  }) as unknown as typeof appDb.withTransaction;

  delete require.cache[require.resolve("../src/server")];
  const { startServer } = require("../src/server");
  server = await startServer();
  baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});

beforeEach(() => {
  users.clear();
  sessions.clear();
  roles.clear();
  userRoles.clear();
  auditLog.length = 0;
  userCounter = 0;
  sessionCounter = 0;
  roleCounter = 0;
  seedSystemRoles();
});

after(async () => {
  await new Promise<void>((resolve, reject) => {
    server.close((err) => (err ? reject(err) : resolve()));
  });
  appDb.query = originalQuery;
  appDb.withTransaction = originalWithTransaction;
});

test("GET /v1/admin/users requires auth and admin role", async () => {
  const admin = seedUser({ email: "admin@example.com", password: "hunter22ok", roleNames: ["admin"] });
  const viewerUser = seedUser({ email: "viewer@example.com", password: "hunter22ok", roleNames: ["viewer"] });

  const noAuth = await api("GET", "/v1/admin/users");
  assert.equal(noAuth.status, 401);

  const viewerSession = seedSession(viewerUser.id);
  const viewerAttempt = await api("GET", "/v1/admin/users", undefined, { cookie: cookieFor(viewerSession.token) });
  assert.equal(viewerAttempt.status, 403);

  const adminSession = seedSession(admin.id);
  const allowed = await api("GET", "/v1/admin/users", undefined, { cookie: cookieFor(adminSession.token) });
  assert.equal(allowed.status, 200);
  assert.equal(allowed.payload.items.length, 2);
  const sorted = [...allowed.payload.items].sort((a, b) => a.email.localeCompare(b.email));
  assert.deepEqual(sorted.map((u) => u.email), ["admin@example.com", "viewer@example.com"]);
  const adminItem = sorted.find((u) => u.email === "admin@example.com");
  const viewerItem = sorted.find((u) => u.email === "viewer@example.com");
  assert.deepEqual(adminItem.roles, ["admin"]);
  assert.deepEqual(viewerItem.roles, ["viewer"]);
});

test("POST /v1/admin/users defaults to viewer role and writes audit log", async () => {
  const admin = seedUser({ email: "root@example.com", password: "hunter22ok", roleNames: ["admin"] });
  const session = seedSession(admin.id);
  const cookie = cookieFor(session.token);

  const created = await api("POST", "/v1/admin/users", {
    email: "  New@Example.com ",
    password: "hunter22ok",
    display_name: "  Newbie  "
  }, { cookie });

  assert.equal(created.status, 201);
  assert.equal(created.payload.email, "new@example.com");
  assert.equal(created.payload.display_name, "Newbie");
  assert.deepEqual(created.payload.roles, ["viewer"]);

  const userCreated = auditLog.find((e) => e.action === "user.created" && e.target_user_id === created.payload.id);
  assert.ok(userCreated);
  assert.equal(userCreated.actor_user_id, admin.id);
  const roleAssigned = auditLog.find((e) => e.action === "role.assigned"
    && e.target_user_id === created.payload.id
    && e.details.role === "viewer");
  assert.ok(roleAssigned);
});

test("POST /v1/admin/users accepts explicit roles", async () => {
  const admin = seedUser({ email: "root@example.com", password: "hunter22ok", roleNames: ["admin"] });
  const cookie = cookieFor(seedSession(admin.id).token);

  const created = await api("POST", "/v1/admin/users", {
    email: "analyst@example.com",
    password: "hunter22ok",
    roles: ["ANALYST", "analyst", " analyst "]
  }, { cookie });

  assert.equal(created.status, 201);
  assert.deepEqual(created.payload.roles, ["analyst"]);
});

test("POST /v1/admin/users rejects invalid input, duplicate email, and unknown roles", async () => {
  const admin = seedUser({ email: "root@example.com", password: "hunter22ok", roleNames: ["admin"] });
  const cookie = cookieFor(seedSession(admin.id).token);

  const badEmail = await api("POST", "/v1/admin/users", {
    email: "not-an-email",
    password: "hunter22ok"
  }, { cookie });
  assert.equal(badEmail.status, 400);

  const shortPassword = await api("POST", "/v1/admin/users", {
    email: "x@y.com",
    password: "short"
  }, { cookie });
  assert.equal(shortPassword.status, 400);

  const created = await api("POST", "/v1/admin/users", {
    email: "dup@example.com",
    password: "hunter22ok"
  }, { cookie });
  assert.equal(created.status, 201);

  const conflict = await api("POST", "/v1/admin/users", {
    email: "DUP@example.com",
    password: "hunter22ok"
  }, { cookie });
  assert.equal(conflict.status, 409);

  const unknownRole = await api("POST", "/v1/admin/users", {
    email: "ghost@example.com",
    password: "hunter22ok",
    roles: ["wizard"]
  }, { cookie });
  assert.equal(unknownRole.status, 400);

  const rolesNotArray = await api("POST", "/v1/admin/users", {
    email: "ghost@example.com",
    password: "hunter22ok",
    roles: "admin"
  }, { cookie });
  assert.equal(rolesNotArray.status, 400);
});

test("POST /v1/admin/users/{id}/roles assigns and revokes with audit and idempotence", async () => {
  const admin = seedUser({ email: "root@example.com", password: "hunter22ok", roleNames: ["admin"] });
  const target = seedUser({ email: "subject@example.com", password: "hunter22ok", roleNames: ["viewer"] });
  const cookie = cookieFor(seedSession(admin.id).token);

  const promote = await api("POST", `/v1/admin/users/${target.id}/roles`, {
    assign: ["analyst"],
    revoke: ["viewer"]
  }, { cookie });
  assert.equal(promote.status, 200);
  assert.deepEqual(promote.payload.assigned, ["analyst"]);
  assert.deepEqual(promote.payload.revoked, ["viewer"]);
  assert.deepEqual(promote.payload.skipped_assign, []);
  assert.deepEqual(promote.payload.skipped_revoke, []);
  assert.deepEqual(promote.payload.user.roles, ["analyst"]);

  const repeat = await api("POST", `/v1/admin/users/${target.id}/roles`, {
    assign: ["analyst"],
    revoke: ["viewer"]
  }, { cookie });
  assert.equal(repeat.status, 200);
  assert.deepEqual(repeat.payload.assigned, []);
  assert.deepEqual(repeat.payload.revoked, []);
  assert.deepEqual(repeat.payload.skipped_assign, ["analyst"]);
  assert.deepEqual(repeat.payload.skipped_revoke, ["viewer"]);
  assert.deepEqual(repeat.payload.user.roles, ["analyst"]);

  const auditAssigned = auditLog.filter((e) => e.action === "role.assigned" && e.target_user_id === target.id);
  const auditRevoked = auditLog.filter((e) => e.action === "role.revoked" && e.target_user_id === target.id);
  assert.equal(auditAssigned.length, 1);
  assert.equal(auditAssigned[0].details.role, "analyst");
  assert.equal(auditRevoked.length, 1);
  assert.equal(auditRevoked[0].details.role, "viewer");
});

test("POST /v1/admin/users/{id}/roles validates input", async () => {
  const admin = seedUser({ email: "root@example.com", password: "hunter22ok", roleNames: ["admin"] });
  const target = seedUser({ email: "subject@example.com", password: "hunter22ok", roleNames: ["viewer"] });
  const cookie = cookieFor(seedSession(admin.id).token);

  const badId = await api("POST", "/v1/admin/users/not-a-uuid/roles", { assign: ["analyst"] }, { cookie });
  assert.equal(badId.status, 400);

  const unknownUser = await api(
    "POST",
    "/v1/admin/users/00000000-0000-4000-8000-aaaa99999999/roles",
    { assign: ["analyst"] },
    { cookie }
  );
  assert.equal(unknownUser.status, 404);

  const empty = await api("POST", `/v1/admin/users/${target.id}/roles`, {}, { cookie });
  assert.equal(empty.status, 400);

  const overlap = await api("POST", `/v1/admin/users/${target.id}/roles`, {
    assign: ["analyst"],
    revoke: ["analyst"]
  }, { cookie });
  assert.equal(overlap.status, 400);

  const unknownRole = await api("POST", `/v1/admin/users/${target.id}/roles`, {
    assign: ["wizard"]
  }, { cookie });
  assert.equal(unknownRole.status, 400);
});

test("admin endpoints require admin role, not just authentication", async () => {
  const analyst = seedUser({ email: "an@example.com", password: "hunter22ok", roleNames: ["analyst"] });
  const target = seedUser({ email: "v@example.com", password: "hunter22ok", roleNames: ["viewer"] });
  const cookie = cookieFor(seedSession(analyst.id).token);

  const list = await api("GET", "/v1/admin/users", undefined, { cookie });
  assert.equal(list.status, 403);

  const create = await api("POST", "/v1/admin/users", {
    email: "new@example.com",
    password: "hunter22ok"
  }, { cookie });
  assert.equal(create.status, 403);

  const update = await api("POST", `/v1/admin/users/${target.id}/roles`, {
    assign: ["analyst"]
  }, { cookie });
  assert.equal(update.status, 403);
});
