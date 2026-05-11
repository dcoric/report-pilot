const { json } = require("./http");
const { readSessionToken, buildClearSessionCookie } = require("./sessionCookie");
const authService = require("../services/authService");
const roleService = require("../services/roleService");

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

module.exports = {
  loadCurrentUser,
  requireAuthenticated,
  requireRole
};
