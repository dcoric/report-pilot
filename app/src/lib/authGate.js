const { json } = require("./http");
const { logEvent } = require("./observability");
const { readSessionToken, buildClearSessionCookie } = require("./sessionCookie");
const authService = require("../services/authService");
const roleService = require("../services/roleService");
const dataSourceAccessService = require("../services/dataSourceAccessService");

async function loadCurrentUser(req) {
  const token = readSessionToken(req);
  if (!token) {
    return null;
  }
  const session = await authService.findActiveSession(token);
  if (!session) {
    return { expired: true };
  }
  const roles = await roleService.listRoleNamesForUser(session.user.id);
  return {
    user: session.user,
    roles,
    sessionId: session.sessionId,
    expiresAt: session.expiresAt
  };
}

function logDecision({ req, decision, userId, policy }) {
  logEvent("authorization", {
    request_id: req.requestId || null,
    user_id: userId || null,
    method: req.method,
    path: req.url,
    decision,
    policy_role: policy && policy.role ? policy.role : null,
    policy_permission: policy && policy.permission ? policy.permission : null,
    policy_public: Boolean(policy && policy.public)
  });
}

async function requireAuthenticated(req, res) {
  const current = await loadCurrentUser(req);
  if (!current) {
    json(res, 401, { error: "unauthenticated" });
    return null;
  }
  if (current.expired) {
    res.setHeader("Set-Cookie", buildClearSessionCookie());
    json(res, 401, { error: "unauthenticated" });
    return null;
  }
  return current;
}

async function requireRole(req, res, roleName) {
  const current = await requireAuthenticated(req, res);
  if (!current) {
    return null;
  }
  if (!current.roles.includes(roleName)) {
    json(res, 403, { error: "forbidden", message: `requires role: ${roleName}` });
    return null;
  }
  return current;
}

// Central enforcement used by the HTTP dispatcher. Returns { allowed: bool }.
// On deny, the response has already been written.
async function enforcePolicy(req, res, policy) {
  if (!policy) {
    // The dispatcher should only call enforcePolicy for paths it expects to
    // handle. A null policy here means the caller decided no enforcement is
    // needed (e.g. static assets); we just record an allow and continue.
    logDecision({ req, decision: "allow_unmapped", userId: null, policy: null });
    return { allowed: true };
  }

  if (policy.public) {
    logDecision({ req, decision: "allow_public", userId: null, policy });
    return { allowed: true };
  }

  const current = await loadCurrentUser(req);
  if (!current) {
    logDecision({ req, decision: "deny_unauthenticated", userId: null, policy });
    json(res, 401, { error: "unauthenticated" });
    return { allowed: false };
  }
  if (current.expired) {
    res.setHeader("Set-Cookie", buildClearSessionCookie());
    logDecision({ req, decision: "deny_expired_session", userId: null, policy });
    json(res, 401, { error: "unauthenticated" });
    return { allowed: false };
  }

  if (policy.role && !current.roles.includes(policy.role)) {
    logDecision({ req, decision: "deny_role", userId: current.user.id, policy });
    json(res, 403, { error: "forbidden", message: `requires role: ${policy.role}` });
    return { allowed: false };
  }

  let permissions = null;
  if (policy.permission) {
    permissions = await roleService.listPermissionNamesForUser(current.user.id);
    if (!permissions.includes(policy.permission)) {
      logDecision({ req, decision: "deny_permission", userId: current.user.id, policy });
      json(res, 403, { error: "forbidden", message: `requires permission: ${policy.permission}` });
      return { allowed: false };
    }
  }

  req.user = current.user;
  req.userRoles = current.roles;
  if (permissions !== null) {
    req.userPermissions = permissions;
  }
  logDecision({ req, decision: "allow", userId: current.user.id, policy });
  return { allowed: true, user: current.user, roles: current.roles, permissions };
}

function isAdmin(req) {
  return Boolean(req.userRoles && req.userRoles.includes("admin"));
}

// Returns true and allows the request to continue. On deny the response has
// already been written (403). The check is skipped for admins.
async function enforceDataSourceAccess(req, res, dataSourceId) {
  if (isAdmin(req)) {
    return true;
  }
  if (!req.user || !dataSourceId) {
    json(res, 403, { error: "forbidden", message: "no access to this data source" });
    return false;
  }
  const allowed = await dataSourceAccessService.hasAccess(req.user.id, dataSourceId);
  if (!allowed) {
    logEvent("authorization", {
      request_id: req.requestId || null,
      user_id: req.user.id,
      method: req.method,
      path: req.url,
      decision: "deny_resource_access",
      resource: "data_source",
      resource_id: dataSourceId
    });
    json(res, 403, { error: "forbidden", message: "no access to this data source" });
    return false;
  }
  return true;
}

// For list endpoints: returns null when the caller is an admin (no filter),
// or an array of accessible data-source UUIDs otherwise. Callers should
// short-circuit to an empty list when the array is empty.
async function listAccessibleDataSourceIds(req) {
  if (isAdmin(req)) {
    return null;
  }
  if (!req.user) {
    return [];
  }
  return dataSourceAccessService.listAccessibleDataSourceIds(req.user.id);
}

module.exports = {
  loadCurrentUser,
  requireAuthenticated,
  requireRole,
  enforcePolicy,
  enforceDataSourceAccess,
  listAccessibleDataSourceIds,
  isAdmin
};
