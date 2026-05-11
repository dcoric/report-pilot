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

const authService = require("../../src/services/authService");

const ROLE_PERMISSIONS = {
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
    "observability.read",
    "observability.write"
  ],
  analyst: [
    "data_sources.read",
    "semantic.write",
    "rag.write",
    "providers.read",
    "query.run",
    "saved_queries.read",
    "saved_queries.write",
    "observability.read"
  ],
  viewer: [
    "data_sources.read",
    "providers.read",
    "saved_queries.read",
    "observability.read"
  ]
};

function uuid(prefix, counter) {
  return `00000000-0000-4000-8000-${prefix}${String(counter).padStart(8, "0")}`;
}

function normalize(sql) {
  return String(sql).replace(/\s+/g, " ").trim().toLowerCase();
}

function createAuthTestStub() {
  const users = new Map();
  const sessions = new Map();
  const userRoles = new Map(); // user_id -> Set of role names
  const dataSourceAccess = new Map(); // user_id -> Set of data_source_id
  let userCounter = 0;
  let sessionCounter = 0;

  function reset() {
    users.clear();
    sessions.clear();
    userRoles.clear();
    dataSourceAccess.clear();
    userCounter = 0;
    sessionCounter = 0;
  }

  function seedUser({ id, email, password = "hunter22ok", displayName = null, isActive = true, roles = [], dataSourceAccess: ds = [] }) {
    if (!id) {
      userCounter += 1;
      id = uuid("aaaa", userCounter);
    }
    const row = {
      id,
      email,
      password_hash: authService.hashPassword(password),
      display_name: displayName,
      is_active: isActive,
      last_login_at: null,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    };
    users.set(id, row);
    const roleSet = new Set();
    for (const role of roles) {
      if (!ROLE_PERMISSIONS[role]) {
        throw new Error(`Unknown role in test stub: ${role}`);
      }
      roleSet.add(role);
    }
    userRoles.set(id, roleSet);
    const accessSet = new Set(Array.isArray(ds) ? ds : []);
    dataSourceAccess.set(id, accessSet);
    return row;
  }

  function grantDataSourceAccess(userId, dataSourceId) {
    if (!dataSourceAccess.has(userId)) {
      dataSourceAccess.set(userId, new Set());
    }
    dataSourceAccess.get(userId).add(dataSourceId);
  }

  function revokeDataSourceAccess(userId, dataSourceId) {
    const set = dataSourceAccess.get(userId);
    if (set) set.delete(dataSourceId);
  }

  function seedSession(userId, { expiresInMs = 60 * 60 * 1000 } = {}) {
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

  function revokeSession(sessionId) {
    const session = sessions.get(sessionId);
    if (session) {
      session.revoked_at = new Date().toISOString();
    }
  }

  function cookieFor(token) {
    return `rp_session=${encodeURIComponent(token)}`;
  }

  function permissionsForUser(userId) {
    const out = new Set();
    const roles = userRoles.get(userId);
    if (!roles) return [];
    for (const role of roles) {
      for (const perm of ROLE_PERMISSIONS[role] || []) {
        out.add(perm);
      }
    }
    return [...out].sort();
  }

  function handleSql(sql, params = []) {
    const normalized = normalize(sql);

    // authService.findActiveSession
    if (normalized.startsWith(
      "select s.id as session_id, s.expires_at, s.revoked_at, u.id, u.email, u.password_hash, u.display_name, u.is_active, u.last_login_at, u.created_at, u.updated_at from user_sessions s join users u on u.id = s.user_id where s.token_hash = $1"
    )) {
      const [tokenHash] = params;
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
      const [userId] = params;
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
      const [userId] = params;
      const perms = permissionsForUser(userId);
      return { rowCount: perms.length, rows: perms.map((name) => ({ name })) };
    }

    // touchSession (handleMe only — but harmless to support)
    if (normalized.startsWith("update user_sessions set last_seen_at = now() where id = $1")) {
      return { rowCount: 1, rows: [] };
    }

    // dataSourceAccessService.hasAccess
    if (normalized.startsWith("select 1 from user_data_source_access where user_id = $1 and data_source_id = $2")) {
      const [userId, dataSourceId] = params;
      const set = dataSourceAccess.get(userId);
      const hit = set ? set.has(dataSourceId) : false;
      return { rowCount: hit ? 1 : 0, rows: hit ? [{ "?column?": 1 }] : [] };
    }

    // dataSourceAccessService.listAccessibleDataSourceIds
    if (normalized.startsWith("select data_source_id from user_data_source_access where user_id = $1")) {
      const [userId] = params;
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

module.exports = {
  createAuthTestStub
};
