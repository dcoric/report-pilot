import "./helpers/setupEnv";
import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";

process.env.DATABASE_URL = process.env.DATABASE_URL || "postgresql://test:test@localhost:5432/test";
process.env.PORT = "0";
process.env.AUTH_COOKIE_SECURE = "false";

import appDb = require("../src/lib/appDb");
import authService = require("../src/services/authService");
import type { AuthUserRow } from "../src/services/authService";

type RoleName = keyof typeof ROLE_PERMISSIONS;

interface TestSession {
  id: string;
  user_id: string;
  token_hash: string;
  user_agent: string | null;
  ip_address: string | null;
  created_at: string;
  expires_at: string;
  last_seen_at: string;
  revoked_at: string | null;
}

interface SeedUserInput {
  email: string;
  password: string;
  displayName?: string | null;
  isActive?: boolean;
  roles?: RoleName[];
}

interface AuthPayload {
  user: {
    email: string;
    display_name: string | null;
    roles: string[];
    permissions: string[];
  };
  expires_at?: string | null;
}

interface ApiResult<T> {
  status: number;
  payload: T;
  setCookie: string | null;
}

let server: import("http").Server;
let baseUrl: string;
let users: Map<string, AuthUserRow>;
let sessions: Map<string, TestSession>;
let userIdCounter: number;
let sessionIdCounter: number;
let userRoleAssignments: Map<string, RoleName[]>;
let originalQuery: typeof appDb.query;

function uuid(prefix: string, counter: number) {
  return `00000000-0000-4000-8000-${prefix}${String(counter).padStart(8, "0")}`;
}

function nextUserId(): string {
  userIdCounter += 1;
  return uuid("aaaa", userIdCounter);
}

function nextSessionId() {
  sessionIdCounter += 1;
  return uuid("bbbb", sessionIdCounter);
}

function normalizeSql(sql: string) {
  return String(sql).replace(/\s+/g, " ").trim().toLowerCase();
}

const ROLE_PERMISSIONS = {
  admin: ["users.read", "users.write", "data_sources.read", "data_sources.write"],
  analyst: ["data_sources.read", "saved_queries.read", "saved_queries.write", "query.run"],
  viewer: ["data_sources.read", "saved_queries.read"]
} as const;

function seedUser({ email, password, displayName = null, isActive = true, roles = [] }: SeedUserInput): AuthUserRow {
  const row: AuthUserRow = {
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
  userRoleAssignments.set(row.id, [...roles]);
  return row;
}

async function api<T = unknown>(
  method: string,
  path: string,
  body?: unknown,
  { cookie }: { cookie?: string } = {}
): Promise<ApiResult<T>> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (cookie) {
    headers.Cookie = cookie;
  }
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined
  });

  let payload: unknown = null;
  try {
    payload = await response.json();
  } catch {
    payload = null;
  }

  return {
    status: response.status,
    payload: payload as T,
    setCookie: response.headers.get("set-cookie")
  };
}

function parseSessionCookieValue(setCookieHeader: string | null): string | null {
  if (!setCookieHeader) {
    return null;
  }
  const match = setCookieHeader.match(/rp_session=([^;]*)/);
  if (!match) {
    return null;
  }
  return decodeURIComponent(match[1]);
}

before(async () => {
  originalQuery = appDb.query;
  users = new Map();
  sessions = new Map();
  userRoleAssignments = new Map();
  userIdCounter = 0;
  sessionIdCounter = 0;

  appDb.query = (async (sql: string, params: unknown[] = []) => {
    const normalized = normalizeSql(sql);

    if (normalized.startsWith("select id, email, password_hash, display_name, is_active, last_login_at, created_at, updated_at from users where lower(email) = $1")) {
      const [emailLower] = params as [string];
      const row = [...users.values()].find((entry) => entry.email.toLowerCase() === emailLower);
      return row ? { rowCount: 1, rows: [row] } : { rowCount: 0, rows: [] };
    }

    if (normalized.startsWith("select id, email, password_hash, display_name, is_active, last_login_at, created_at, updated_at from users where id = $1")) {
      const [id] = params as [string];
      const row = users.get(id);
      return row ? { rowCount: 1, rows: [row] } : { rowCount: 0, rows: [] };
    }

    if (normalized.startsWith("insert into users")) {
      const [email, passwordHash, displayName] = params as [string, string, string | null];
      const row: AuthUserRow = {
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
      return { rowCount: 1, rows: [row] };
    }

    if (normalized.startsWith("insert into user_sessions")) {
      const [userId, tokenHash, userAgent, ipAddress, expiresAt] = params as [
        string,
        string,
        string | null,
        string | null,
        string
      ];
      const row: TestSession = {
        id: nextSessionId(),
        user_id: userId,
        token_hash: tokenHash,
        user_agent: userAgent,
        ip_address: ipAddress,
        created_at: new Date().toISOString(),
        expires_at: expiresAt,
        last_seen_at: new Date().toISOString(),
        revoked_at: null
      };
      sessions.set(row.id, row);
      return { rowCount: 1, rows: [{ id: row.id, expires_at: row.expires_at }] };
    }

    if (
      normalized.startsWith(
        "select s.id as session_id, s.expires_at, s.revoked_at, u.id, u.email, u.password_hash, u.display_name, u.is_active, u.last_login_at, u.created_at, u.updated_at from user_sessions s join users u on u.id = s.user_id where s.token_hash = $1"
      )
    ) {
      const [tokenHash] = params as [string];
      const session = [...sessions.values()].find((entry) => entry.token_hash === tokenHash);
      if (!session) {
        return { rowCount: 0, rows: [] };
      }
      const user = users.get(session.user_id);
      if (!user) {
        return { rowCount: 0, rows: [] };
      }
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

    if (normalized.startsWith("update user_sessions set last_seen_at = now() where id = $1")) {
      const [id] = params as [string];
      const session = sessions.get(id);
      if (session) {
        session.last_seen_at = new Date().toISOString();
      }
      return { rowCount: session ? 1 : 0, rows: [] };
    }

    if (normalized.startsWith("update user_sessions set revoked_at = now() where token_hash = $1 and revoked_at is null")) {
      const [tokenHash] = params as [string];
      let count = 0;
      for (const session of sessions.values()) {
        if (session.token_hash === tokenHash && !session.revoked_at) {
          session.revoked_at = new Date().toISOString();
          count += 1;
        }
      }
      return { rowCount: count, rows: [] };
    }

    if (normalized.startsWith("update users set last_login_at = now() where id = $1")) {
      const [id] = params as [string];
      const user = users.get(id);
      if (user) {
        user.last_login_at = new Date().toISOString();
      }
      return { rowCount: user ? 1 : 0, rows: [] };
    }

    if (normalized.startsWith(
      "select r.id, r.name, r.description, r.is_system, ur.assigned_at from user_roles ur join roles r on r.id = ur.role_id where ur.user_id = $1 order by r.name"
    )) {
      const [userId] = params as [string];
      const assigned = userRoleAssignments.get(userId) || [];
      const rows = [...assigned].sort().map((name, idx) => ({
        id: `00000000-0000-4000-8000-cccc${String(idx + 1).padStart(8, "0")}`,
        name,
        description: `${name} role`,
        is_system: true,
        assigned_at: new Date().toISOString()
      }));
      return { rowCount: rows.length, rows };
    }

    if (normalized.startsWith(
      "select distinct p.name from user_roles ur join role_permissions rp on rp.role_id = ur.role_id join permissions p on p.id = rp.permission_id where ur.user_id = $1 order by p.name"
    )) {
      const [userId] = params as [string];
      const assigned = userRoleAssignments.get(userId) || [];
      const out = new Set<string>();
      for (const role of assigned) {
        for (const perm of ROLE_PERMISSIONS[role] || []) {
          out.add(perm);
        }
      }
      const sorted = [...out].sort();
      return { rowCount: sorted.length, rows: sorted.map((name) => ({ name })) };
    }

    throw new Error(`Unexpected SQL in auth test stub: ${normalized}`);
  }) as unknown as typeof appDb.query;

  delete require.cache[require.resolve("../src/server")];
  const { startServer } = require("../src/server");
  server = await startServer();
  baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});

beforeEach(() => {
  users.clear();
  sessions.clear();
  userRoleAssignments.clear();
  userIdCounter = 0;
  sessionIdCounter = 0;
});

after(async () => {
  await new Promise<void>((resolve, reject) => {
    server.close((err) => (err ? reject(err) : resolve()));
  });
  appDb.query = originalQuery;
});

test("login → me → logout happy path", async () => {
  seedUser({
    email: "alice@example.com",
    password: "hunter22ok",
    displayName: "Alice",
    roles: ["analyst"]
  });

  const login = await api<AuthPayload>("POST", "/v1/auth/login", {
    email: "Alice@Example.com",
    password: "hunter22ok"
  });
  assert.equal(login.status, 200);
  assert.equal(login.payload.user.email, "alice@example.com");
  assert.equal(login.payload.user.display_name, "Alice");
  assert.deepEqual(login.payload.user.roles, ["analyst"]);
  assert.deepEqual(
    login.payload.user.permissions,
    ["data_sources.read", "query.run", "saved_queries.read", "saved_queries.write"]
  );
  assert.ok(login.payload.expires_at);
  assert.ok(login.setCookie);
  assert.match(login.setCookie, /HttpOnly/);
  assert.match(login.setCookie, /SameSite=Lax/);

  const token = parseSessionCookieValue(login.setCookie);
  assert.ok(token, "expected session token");
  assert.match(token, /^[0-9a-f]{64}$/);

  const cookie = `rp_session=${encodeURIComponent(token)}`;
  const me = await api<AuthPayload>("GET", "/v1/auth/me", undefined, { cookie });
  assert.equal(me.status, 200);
  assert.equal(me.payload.user.email, "alice@example.com");
  assert.deepEqual(me.payload.user.roles, ["analyst"]);
  assert.deepEqual(
    me.payload.user.permissions,
    ["data_sources.read", "query.run", "saved_queries.read", "saved_queries.write"]
  );

  const logout = await api<{ ok: boolean }>("POST", "/v1/auth/logout", undefined, { cookie });
  assert.equal(logout.status, 200);
  assert.deepEqual(logout.payload, { ok: true });
  assert.ok(logout.setCookie);
  assert.match(logout.setCookie, /Max-Age=0/);

  const meAfterLogout = await api("GET", "/v1/auth/me", undefined, { cookie });
  assert.equal(meAfterLogout.status, 401);
});

test("login fails with 401 on wrong password and unknown email", async () => {
  seedUser({ email: "bob@example.com", password: "supersecret" });

  const wrongPassword = await api("POST", "/v1/auth/login", {
    email: "bob@example.com",
    password: "wrong-password"
  });
  assert.equal(wrongPassword.status, 401);
  assert.equal(wrongPassword.setCookie, null);

  const unknownEmail = await api("POST", "/v1/auth/login", {
    email: "nobody@example.com",
    password: "supersecret"
  });
  assert.equal(unknownEmail.status, 401);
});

test("login fails with 400 when fields are missing", async () => {
  const noBody = await api("POST", "/v1/auth/login", {});
  assert.equal(noBody.status, 400);

  const noPassword = await api("POST", "/v1/auth/login", { email: "x@y.com" });
  assert.equal(noPassword.status, 400);

  const noEmail = await api("POST", "/v1/auth/login", { password: "supersecret" });
  assert.equal(noEmail.status, 400);
});

test("inactive users cannot log in", async () => {
  seedUser({ email: "ghost@example.com", password: "hunter22ok", isActive: false });
  const login = await api("POST", "/v1/auth/login", {
    email: "ghost@example.com",
    password: "hunter22ok"
  });
  assert.equal(login.status, 401);
});

test("me returns 401 without a cookie and with a bogus cookie", async () => {
  const noCookie = await api("GET", "/v1/auth/me");
  assert.equal(noCookie.status, 401);

  const bogus = await api("GET", "/v1/auth/me", undefined, { cookie: "rp_session=not-a-real-token" });
  assert.equal(bogus.status, 401);
});

test("logout without a session is a no-op that still clears the cookie", async () => {
  const logout = await api("POST", "/v1/auth/logout");
  assert.equal(logout.status, 200);
  assert.ok(logout.setCookie);
  assert.match(logout.setCookie, /Max-Age=0/);
});
