const { json, badRequest } = require("../lib/http");
const { buildFlowCookie, buildClearFlowCookie, readFlowCookie } = require("../lib/oidcFlowCookie");
const { buildSessionCookie, buildClearSessionCookie } = require("../lib/sessionCookie");
const authService = require("../services/authService");
const auditService = require("../services/auditService");
const authProviderService = require("../services/authProviderService");
const oidcService = require("../services/oidcService");

function clientAddress(req) {
  const fwd = req.headers["x-forwarded-for"];
  if (typeof fwd === "string" && fwd.length > 0) {
    const first = fwd.split(",")[0];
    if (first) return first.trim();
  }
  return req.socket && req.socket.remoteAddress ? req.socket.remoteAddress : null;
}

async function handleListEnabledProviders(_req, res) {
  const items = await authProviderService.listEnabledProvidersForLogin();
  return json(res, 200, { items });
}

async function handleStartLogin(req, res, requestUrl) {
  const providerId = requestUrl.searchParams.get("provider_id");
  if (!providerId) {
    return badRequest(res, "provider_id query parameter is required");
  }
  const provider = await authProviderService.findProviderById(providerId, { withSecret: true });
  if (!provider || !provider.enabled) {
    return json(res, 404, { error: "not_found", message: "auth provider not found or disabled" });
  }

  let result;
  try {
    result = await oidcService.startLogin(provider);
  } catch (err) {
    const status = err.statusCode || 500;
    return json(res, status, { error: "oidc_error", message: err.message });
  }

  res.setHeader("Set-Cookie", buildFlowCookie(result.flowState));
  res.writeHead(302, { Location: result.authorizeUrl });
  return res.end();
}

function redirectAfterLogin(res, target = "/dashboard", sessionCookie = null) {
  const headers = { Location: target };
  if (sessionCookie) {
    headers["Set-Cookie"] = sessionCookie;
  }
  res.writeHead(302, headers);
  return res.end();
}

async function handleCallback(req, res, requestUrl) {
  const flowState = readFlowCookie(req);
  if (!flowState) {
    return json(res, 400, { error: "bad_request", message: "missing or expired OIDC flow state" });
  }

  const provider = await authProviderService.findProviderById(flowState.provider_id, { withSecret: true });
  if (!provider || !provider.enabled) {
    res.setHeader("Set-Cookie", buildClearFlowCookie());
    return json(res, 404, { error: "not_found", message: "auth provider no longer available" });
  }

  // Build the full callback URL openid-client expects (origin + path + query).
  const host = req.headers["x-forwarded-host"] || req.headers.host || "localhost";
  const proto = req.headers["x-forwarded-proto"] || (req.socket && req.socket.encrypted ? "https" : "http");
  const currentUrl = `${proto}://${host}${requestUrl.pathname}${requestUrl.search}`;

  const ipAddress = clientAddress(req);
  const userAgent = req.headers["user-agent"] || null;

  let principal;
  try {
    principal = await oidcService.completeLogin(provider, currentUrl, flowState);
  } catch (err) {
    res.setHeader("Set-Cookie", buildClearFlowCookie());
    await auditService
      .writeEvent({
        action: "auth.login.failure",
        outcome: "failure",
        details: { method: "oidc", provider: provider.name, reason: err.message || "oidc_error" },
        ipAddress,
        userAgent
      })
      .catch(() => {});
    const status = err.statusCode || 500;
    return json(res, status, { error: "oidc_error", message: err.message });
  }

  const user = await authService.findUserByEmail(principal.email);
  if (!user || !user.is_active) {
    res.setHeader("Set-Cookie", buildClearFlowCookie());
    await auditService
      .writeEvent({
        actorEmail: principal.email,
        action: "auth.login.failure",
        outcome: "failure",
        details: { method: "oidc", provider: provider.name, reason: "no_local_account" },
        ipAddress,
        userAgent
      })
      .catch(() => {});
    return json(res, 403, {
      error: "forbidden",
      message: `no active local account for ${principal.email}. Ask an administrator to create one.`
    });
  }

  const session = await authService.createSession(user.id, {
    userAgent,
    ipAddress
  });
  await auditService
    .writeEvent({
      actorUserId: user.id,
      actorEmail: user.email,
      targetUserId: user.id,
      action: "auth.login.success",
      outcome: "success",
      details: { method: "oidc", provider: provider.name },
      ipAddress,
      userAgent
    })
    .catch(() => {});
  // Best-effort last_login_at touch; mirrors password login path.
  authService
    .findUserByEmail(principal.email)
    .then(() => {})
    .catch(() => {});

  const sessionCookie = buildSessionCookie(session.token, session.expiresAt);
  const clearFlowCookie = buildClearFlowCookie();

  // Browsers accept multiple Set-Cookie headers but Node's writeHead expects an
  // array for duplicate header names.
  res.setHeader("Set-Cookie", [sessionCookie, clearFlowCookie]);
  return redirectAfterLogin(res, "/dashboard");
}

// Exposed for use by AUTH-009 (admin "test connection" button) and tests.
async function handleStartLoginJson(req, res, requestUrl) {
  const providerId = requestUrl.searchParams.get("provider_id");
  if (!providerId) {
    return badRequest(res, "provider_id query parameter is required");
  }
  const provider = await authProviderService.findProviderById(providerId, { withSecret: true });
  if (!provider || !provider.enabled) {
    return json(res, 404, { error: "not_found", message: "auth provider not found or disabled" });
  }
  try {
    const result = await oidcService.startLogin(provider);
    res.setHeader("Set-Cookie", buildFlowCookie(result.flowState));
    return json(res, 200, { authorize_url: result.authorizeUrl });
  } catch (err) {
    const status = err.statusCode || 500;
    return json(res, status, { error: "oidc_error", message: err.message });
  }
}

module.exports = {
  handleListEnabledProviders,
  handleStartLogin,
  handleStartLoginJson,
  handleCallback,
  // Re-exported so the logout handler can clear the auxiliary cookie too.
  buildClearFlowCookie,
  buildClearSessionCookie
};
