import { json, badRequest, readJsonBody, errorMessage, type RouteHandler, type RouteHandlerWithUrl } from "../lib/http";
import { buildFlowCookie, buildClearFlowCookie } from "../lib/oidcFlowCookie";
import { createSession } from "../services/authService";
import { writeEvent } from "../services/auditService";
import { listEnabledProvidersForLogin, findProviderById } from "../services/authProviderService";
import { resolveExternalLogin } from "../services/externalLoginService";
import { createAuthProviderService } from "../services/authProviders";
import { clientAddress } from "../lib/http";
import type { AuthProviderType } from "../types/domain";

// This is a unified external auth router that handles all auth provider types
// It routes requests to the appropriate provider service based on the provider type

const handleListEnabledProviders: RouteHandler = async (_req, res) => {
  const items = await listEnabledProvidersForLogin();
  return json(res, 200, { items });
};

const handleStartLogin: RouteHandlerWithUrl = async (_req, res, requestUrl) => {
  const providerId = requestUrl.searchParams.get("provider_id");
  if (!providerId) {
    return badRequest(res, "provider_id query parameter is required");
  }
  
  const provider = await findProviderById(providerId, { withSecret: true });
  if (!provider || !provider.enabled) {
    return json(res, 404, { error: "not_found", message: "auth provider not found or disabled" });
  }
  
  // Get the appropriate service based on provider type
  const service = createAuthProviderService(provider.type as AuthProviderType);
  if (!service) {
    return json(res, 500, { error: "internal_error", message: "unsupported provider type" });
  }
  
  try {
    const result = await service.startLogin(provider);
    res.setHeader("Set-Cookie", buildFlowCookie(result.flowState));
    res.writeHead(302, { Location: result.authorizeUrl });
    res.end();
    return;
  } catch (err) {
    return json(res, 500, { error: "auth_error", message: errorMessage(err) });
  }
};

function redirectAfterLogin(res: any, target = "/dashboard", sessionCookie: string | null = null): void {
  const headers: Record<string, string | string[]> = { Location: target };
  if (sessionCookie) {
    headers["Set-Cookie"] = sessionCookie;
  }
  res.writeHead(302, headers);
  res.end();
}

const handleCallback: RouteHandlerWithUrl = async (req, res, requestUrl) => {
  const flowState = buildFlowCookie(req);
  if (!flowState) {
    return json(res, 400, { error: "bad_request", message: "missing or expired OIDC flow state" });
  }

  const provider = await findProviderById(flowState.provider_id, { withSecret: true });
  if (!provider || !provider.enabled) {
    res.setHeader("Set-Cookie", buildClearFlowCookie());
    return json(res, 404, { error: "not_found", message: "auth provider no longer available" });
  }

  // Get the appropriate service based on provider type
  const service = createAuthProviderService(provider.type as AuthProviderType);
  if (!service) {
    res.setHeader("Set-Cookie", buildClearFlowCookie());
    return json(res, 500, { error: "internal_error", message: "unsupported provider type" });
  }

  // Build the full callback URL
  const host = req.headers["x-forwarded-host"] || req.headers.host || "localhost";
  const proto = req.headers["x-forwarded-proto"] || (req.socket && (req.socket as { encrypted?: boolean }).encrypted ? "https" : "http");
  const currentUrl = `${proto}://${host}${requestUrl.pathname}${requestUrl.search}`;

  const ipAddress = clientAddress(req);
  const userAgent = req.headers["user-agent"] || null;

  let principal;
  try {
    principal = await service.completeLogin(provider, currentUrl, flowState);
  } catch (err) {
    res.setHeader("Set-Cookie", buildClearFlowCookie());
    const message = errorMessage(err);
    await writeEvent({
      action: "auth.login.failure",
      outcome: "failure",
      details: { method: provider.type, provider: provider.name, reason: message || "auth_error" },
      ipAddress,
      userAgent
    }).catch(() => {});
    return json(res, 500, { error: "auth_error", message });
  }

  // Resolve the IdP principal to a local user
  const resolution = await resolveExternalLogin(
    provider,
    principal,
    { ipAddress, userAgent }
  );
  if (resolution.ok === false) {
    res.setHeader("Set-Cookie", buildClearFlowCookie());
    await writeEvent({
      actorEmail: principal.email,
      action: "auth.login.failure",
      outcome: "failure",
      details: {
        method: provider.type,
        provider: provider.name,
        reason: resolution.code
      },
      ipAddress,
      userAgent
    }).catch(() => {});
    return json(res, resolution.status, {
      error: resolution.status === 409 ? "conflict" : "forbidden",
      code: resolution.code,
      message: resolution.message
    });
  }
  const user = resolution.user;

  const session = await createSession(user.id, {
    userAgent,
    ipAddress
  });
  await writeEvent({
    actorUserId: user.id,
    actorEmail: user.email,
    targetUserId: user.id,
    action: "auth.login.success",
    outcome: "success",
    details: { method: provider.type, provider: provider.name, mode: resolution.mode },
    ipAddress,
    userAgent
  }).catch(() => {});

  const sessionCookie = buildSessionCookie(session.token, session.expiresAt);
  const clearFlowCookie = buildClearFlowCookie();

  // Browsers accept multiple Set-Cookie headers but Node's writeHead expects an
  // array for duplicate header names.
  res.setHeader("Set-Cookie", [sessionCookie, clearFlowCookie]);
  return redirectAfterLogin(res, "/dashboard");
};

export {
  handleListEnabledProviders,
  handleStartLogin,
  handleCallback
};