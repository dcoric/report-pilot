const { json, readJsonBody, badRequest } = require("../lib/http");
const {
  buildSessionCookie,
  buildClearSessionCookie,
  readSessionToken
} = require("../lib/sessionCookie");
const authService = require("../services/authService");
const roleService = require("../services/roleService");

function clientAddress(req) {
  const forwarded = req.headers["x-forwarded-for"];
  if (typeof forwarded === "string" && forwarded.length > 0) {
    const first = forwarded.split(",")[0];
    if (first) {
      return first.trim();
    }
  }
  return req.socket && req.socket.remoteAddress ? req.socket.remoteAddress : null;
}

function publicUser(user, { roles = [], permissions = [] } = {}) {
  if (!user) {
    return null;
  }
  return {
    id: user.id,
    email: user.email,
    display_name: user.display_name,
    is_active: user.is_active,
    last_login_at: user.last_login_at,
    created_at: user.created_at,
    roles,
    permissions
  };
}

async function loadAuthorization(userId) {
  const [roles, permissions] = await Promise.all([
    roleService.listRoleNamesForUser(userId),
    roleService.listPermissionNamesForUser(userId)
  ]);
  return { roles, permissions };
}

async function handleLogin(req, res) {
  const body = await readJsonBody(req);
  const email = typeof body.email === "string" ? body.email : "";
  const password = typeof body.password === "string" ? body.password : "";

  if (!email || !password) {
    return badRequest(res, "email and password are required");
  }

  const result = await authService.loginWithPassword({
    email,
    password,
    userAgent: req.headers["user-agent"] || null,
    ipAddress: clientAddress(req)
  });

  if (!result) {
    return json(res, 401, { error: "invalid_credentials" });
  }

  const authz = await loadAuthorization(result.user.id);
  res.setHeader("Set-Cookie", buildSessionCookie(result.token, result.expiresAt));
  return json(res, 200, {
    user: publicUser(result.user, authz),
    expires_at: result.expiresAt
  });
}

async function handleLogout(req, res) {
  const token = readSessionToken(req);
  if (token) {
    await authService.revokeSessionByToken(token);
  }
  res.setHeader("Set-Cookie", buildClearSessionCookie());
  return json(res, 200, { ok: true });
}

async function handleMe(req, res) {
  const token = readSessionToken(req);
  if (!token) {
    return json(res, 401, { error: "unauthenticated" });
  }
  const session = await authService.findActiveSession(token);
  if (!session) {
    res.setHeader("Set-Cookie", buildClearSessionCookie());
    return json(res, 401, { error: "unauthenticated" });
  }
  authService.touchSession(session.sessionId).catch(() => {});
  const authz = await loadAuthorization(session.user.id);
  return json(res, 200, {
    user: publicUser(session.user, authz),
    expires_at: session.expiresAt
  });
}

module.exports = {
  handleLogin,
  handleLogout,
  handleMe
};
