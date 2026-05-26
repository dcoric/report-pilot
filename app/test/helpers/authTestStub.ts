// Test helper for AUTH-003: provides in-memory user/session/role/permission
// fixtures plus a SQL handler that satisfies the read paths used by
// `lib/authGate.enforcePolicy`.
//
// Usage:
//   const stub = createAuthTestStub();
//   stub.seedUser({ email: "alice@example.com", roles: ["analyst"] });
//   const cookie = stub.cookieFor(stub.seedSession(userId).token);
//   const oldQuery = appDb.query;
//   appDb.query = (sql, params) => {
//     const auth = stub.handleSql(sql, params);
//     if (auth) return auth;
//     // ...domain-specific stub here
//   };
//
// The helper does NOT clear state between tests; call `stub.reset()` from
// `beforeEach` if isolation is needed.

import * as authService from "../../src/services/authService";

// AUTH-006 added users.read_self / users.write_self, granted to every
// system role. Mirror that here so route tests against /v1/users/me/*
// don't 403.
const SELF_PERMS = ["users.read_self", "users.write_self"];

const ROLE_PERMISSIONS: Record<string, string[]> = {
  admin: [
    "users.read",
    "users.write",
    "roles.assign",
    "data_sources.read",
    "data_sources.write",
    "semantic.write",
    "rag.write",
    "providers.read",
    "providers.write",
    "query.run",
    "saved_queries.read",
    "saved_queries.write",
    "saved_queries.share",
    "saved_queries.schedule",
    "observability.read",
    "observability.write",
    ...SELF_PERMS
  ],
  analyst: [
    "data_sources.read",
    "semantic.write",
    "rag.write",
    "providers.read",
    "query.run",
    "saved_queries.read",
    "saved_queries.write",
    "saved_queries.share",
    "saved_queries.schedule",
    "observability.read",
    ...SELF_PERMS
  ],
  viewer: [
    "data_sources.read",
    "providers.read",
    "saved_queries.read",
    "observability.read",
    ...SELF_PERMS
  ]
};

interface SeededUser {
  id: string;
  email: string;
  password_hash: string;
  display_name: string | null;
  is_active: boolean;
  last_login_at: string | null;
  created_at: string;
  updated_at: string;
}

interface SeededSession {
  id: string;
  user_id: string;
  token_hash: string;
  user_agent?: string | null;
  ip_address?: string | null;
  created_at?: string;
  expires_at: string;
  last_seen_at?: string;
  revoked_at: string | null;
}

export interface SeedUserInput {
  id?: string;
  email: string;
  password?: string;
  displayName?: string | null;
  isActive?: boolean;
  roles?: string[];
  dataSourceAccess?: string[];
}

export interface SeedSessionResult {
  sessionId: string;
  token: string;
  expiresAt: string;
}

export interface StubQueryResult {
  rowCount: number;
  rows: Record<string, unknown>[];
}

export interface AuthTestStub {
  reset(): void;
  seedUser(input: SeedUserInput): SeededUser;
  seedSession(userId: string, opts?: { expiresInMs?: number }): SeedSessionResult;
  revokeSession(sessionId: string): void;
  grantDataSourceAccess(userId: string, dataSourceId: string): void;
  revokeDataSourceAccess(userId: string, dataSourceId: string): void;
  cookieFor(token: string): string;
  handleSql(sql: string, params?: unknown[]): StubQueryResult | null;
  ROLE_PERMISSIONS: Record<string, string[]>;
}

function uuid(prefix: string, counter: number): string {
  return `00000000-0000-4000-8000-${prefix}${String(counter).padStart(8, "0")}`;
}

function normalize(sql: string): string {
  return String(sql).replace(/\s+/g, " ").trim().toLowerCase();
}

export function createAuthTestStub(): AuthTestStub {
  const users = new Map<string, SeededUser>();
  const sessions = new Map<string, SeededSession>();
  const userRoles = new Map<string, Set<string>>(); // user_id -> Set of role names
  const dataSourceAccess = new Map<string, Set<string>>(); // user_id -> Set of data_source_id
  let userCounter = 0;
  let sessionCounter = 0;

  function reset(): void {
    users.clear();
    sessions.clear();
    userRoles.clear();
    dataSourceAccess.clear();
    userCounter = 0;
    sessionCounter = 0;
  }

  function seedUser({
    id,
    email,
    password = "hunter22ok",
    displayName = null,
    isActive = true,
    roles = [],
    dataSourceAccess: ds = []
  }: SeedUserInput): SeededUser {
    let userId = id;
    if (!userId) {
      userCounter += 1;
      userId = uuid("aaaa", userCounter);
    }
    const row: SeededUser = {
      id: userId,
      email,
      password_hash: authService.hashPassword(password),
      display_name: displayName,
      is_active: isActive,
      last_login_at: null,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    };
    users.set(userId, row);
    const roleSet = new Set<string>();
    for (const role of roles) {
      if (!ROLE_PERMISSIONS[role]) {
        throw new Error(`Unknown role in test stub: ${role}`);
      }
      roleSet.add(role);
    }
    userRoles.set(userId, roleSet);
    const accessSet = new Set(Array.isArray(ds) ? ds : []);
    dataSourceAccess.set(userId, accessSet);
    return row;
  }

  function grantDataSourceAccess(userId: string, dataSourceId: string): void {
    if (!dataSourceAccess.has(userId)) {
      dataSourceAccess.set(userId, new Set());
    }
    dataSourceAccess.get(userId)!.add(dataSourceId);
  }

  function revokeDataSourceAccess(userId: string, dataSourceId: string): void {
    const set = dataSourceAccess.get(userId);
    if (set) set.delete(dataSourceId);
  }

  function seedSession(userId: string, { expiresInMs = 60 * 60 * 1000 }: { expiresInMs?: number } = {}): SeedSessionResult {
    if (!users.has(userId)) {
      throw new Error(`Cannot seed session for unknown user ${userId}`);
    }
    sessionCounter += 1;
    const sessionId = uuid("bbbb", sessionCounter);
    const token = authService.generateSessionToken();
    const tokenHash = authService.hashSessionToken(token);
    const expiresAt = new Date(Date.now() + expiresInMs).toISOString();
    sessions.set(sessionId, {
      id: sessionId,
      user_id: userId,
      token_hash: tokenHash,
      expires_at: expiresAt,
      revoked_at: null
    });
    return { sessionId, token, expiresAt };
  }

  function revokeSession(sessionId: string): void {
    const session = sessions.get(sessionId);
    if (session) {
      session.revoked_at = new Date().toISOString();
    }
  }

  function cookieFor(token: string): string {
    return `rp_session=${encodeURIComponent(token)}`;
  }

  function permissionsForUser(userId: string): string[] {
    const out = new Set<string>();
    const roles = userRoles.get(userId);
    if (!roles) return [];
    for (const role of roles) {
      for (const perm of ROLE_PERMISSIONS[role] || []) {
        out.add(perm);
      }
    }
    return [...out].sort();
  }

  function handleSql(sql: string, params: unknown[] = []): StubQueryResult | null {
    const normalized = normalize(sql);

    // authService.findActiveSession
    if (normalized.startsWith(
      "select s.id as session_id, s.expires_at, s.revoked_at, u.id, u.email, u.password_hash, u.display_name, u.is_active, u.last_login_at, u.created_at, u.updated_at from user_sessions s join users u on u.id = s.user_id where s.token_hash = $1"
    )) {
      const [tokenHash] = params as [string];
      const session = [...sessions.values()].find((s) => s.token_hash === tokenHash);
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

    // roleService.listRolesForUser
    if (normalized.startsWith(
      "select r.id, r.name, r.description, r.is_system, ur.assigned_at from user_roles ur join roles r on r.id = ur.role_id where ur.user_id = $1 order by r.name"
    )) {
      const [userId] = params as [string];
      const roles = userRoles.get(userId);
      if (!roles) return { rowCount: 0, rows: [] };
      const rows = [...roles].sort().map((name, idx) => ({
        id: uuid("cccc", idx + 1),
        name,
        description: `${name} role`,
        is_system: true,
        assigned_at: new Date().toISOString()
      }));
      return { rowCount: rows.length, rows };
    }

    // roleService.listPermissionNamesForUser
    if (normalized.startsWith(
      "select distinct p.name from user_roles ur join role_permissions rp on rp.role_id = ur.role_id join permissions p on p.id = rp.permission_id where ur.user_id = $1 order by p.name"
    )) {
      const [userId] = params as [string];
      const perms = permissionsForUser(userId);
      return { rowCount: perms.length, rows: perms.map((name) => ({ name })) };
    }

    // touchSession (handleMe only — but harmless to support)
    if (normalized.startsWith("update user_sessions set last_seen_at = now() where id = $1")) {
      return { rowCount: 1, rows: [] };
    }

    // authService.createSession — sessions created by the real code (e.g.
    // password login or OIDC callback) get persisted into the stub's map so
    // subsequent /v1/auth/me lookups see them.
    if (normalized.startsWith("insert into user_sessions")) {
      const [userId, tokenHash, userAgent, ipAddress, expiresAt] = params as [string, string, string | null, string | null, string];
      sessionCounter += 1;
      const sessionId = uuid("bbbb", sessionCounter);
      sessions.set(sessionId, {
        id: sessionId,
        user_id: userId,
        token_hash: tokenHash,
        user_agent: userAgent,
        ip_address: ipAddress,
        created_at: new Date().toISOString(),
        expires_at: expiresAt,
        last_seen_at: new Date().toISOString(),
        revoked_at: null
      });
      return { rowCount: 1, rows: [{ id: sessionId, expires_at: expiresAt }] };
    }

    // dataSourceAccessService.hasAccess
    if (normalized.startsWith("select 1 from user_data_source_access where user_id = $1 and data_source_id = $2")) {
      const [userId, dataSourceId] = params as [string, string];
      const set = dataSourceAccess.get(userId);
      const hit = set ? set.has(dataSourceId) : false;
      return { rowCount: hit ? 1 : 0, rows: hit ? [{ "?column?": 1 }] : [] };
    }

    // dataSourceAccessService.listAccessibleDataSourceIds
    if (normalized.startsWith("select data_source_id from user_data_source_access where user_id = $1")) {
      const [userId] = params as [string];
      const set = dataSourceAccess.get(userId);
      const ids = set ? [...set] : [];
      return { rowCount: ids.length, rows: ids.map((id) => ({ data_source_id: id })) };
    }

    return null;
  }

  return {
    reset,
    seedUser,
    seedSession,
    revokeSession,
    grantDataSourceAccess,
    revokeDataSourceAccess,
    cookieFor,
    handleSql,
    ROLE_PERMISSIONS
  };
}
