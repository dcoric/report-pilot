const { json, readJsonBody, badRequest } = require("../lib/http");
const {
  buildSessionCookie,
  buildClearSessionCookie,
  readSessionToken
} = require("../lib/sessionCookie");
const authService = require("../services/authService");
const auditService = require("../services/auditService");
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

  const userAgent = req.headers["user-agent"] || null;
  const ipAddress = clientAddress(req);

  const result = await authService.loginWithPassword({
    email,
    password,
    userAgent,
    ipAddress
  });

  if (!result) {
    // Record the failed attempt for compliance / brute-force detection. We
    // don't have a user row to point at, so the email is stored on
    // actor_email and actor_user_id stays null.
    await auditService
      .writeEvent({
        actorEmail: email,
        action: "auth.login.failure",
        outcome: "failure",
        details: { reason: "invalid_credentials" },
        ipAddress,
        userAgent
      })
      .catch(() => {});
    return json(res, 401, { error: "invalid_credentials" });
  }

  const authz = await loadAuthorization(result.user.id);
  res.setHeader("Set-Cookie", buildSessionCookie(result.token, result.expiresAt));
  await auditService
    .writeEvent({
      actorUserId: result.user.id,
      actorEmail: result.user.email,
      targetUserId: result.user.id,
      action: "auth.login.success",
      outcome: "success",
      details: { method: "password" },
      ipAddress,
      userAgent
    })
    .catch(() => {});
  return json(res, 200, {
    user: publicUser(result.user, authz),
    expires_at: result.expiresAt
  });
}

async function handleLogout(req, res) {
  const token = readSessionToken(req);
  let session = null;
  if (token) {
    session = await authService.findActiveSession(token);
    await authService.revokeSessionByToken(token);
  }
  if (session && session.user) {
    await auditService
      .writeEvent({
        actorUserId: session.user.id,
        actorEmail: session.user.email,
        targetUserId: session.user.id,
        action: "auth.logout",
        outcome: "success",
        ipAddress: clientAddress(req),
        userAgent: req.headers["user-agent"] || null
      })
      .catch(() => {});
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
