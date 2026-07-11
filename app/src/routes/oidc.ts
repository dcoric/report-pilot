import type { ServerResponse } from "http";
import type { AuthedRequest } from "../lib/authGate";
import {
  json,
  badRequest,
  errorMessage,
  type RouteHandler,
  type RouteHandlerWithUrl
} from "../lib/http";
import { buildFlowCookie, buildClearFlowCookie, readFlowCookie } from "../lib/oidcFlowCookie";
import { buildSessionCookie, buildClearSessionCookie } from "../lib/sessionCookie";
import { createSession } from "../services/authService";
import { writeEvent } from "../services/auditService";
import { listEnabledProvidersForLogin, findProviderById } from "../services/authProviderService";
import { resolveExternalLogin } from "../services/externalLoginService";
import { startLogin, completeLogin } from "../services/oidcService";
import { recordUsedState } from "../services/oidcStateService";

function clientAddress(req: AuthedRequest): string | null {
  const fwd = req.headers["x-forwarded-for"];
  if (typeof fwd === "string" && fwd.length > 0) {
    const first = fwd.split(",")[0];
    if (first) return first.trim();
  }
  return req.socket && req.socket.remoteAddress ? req.socket.remoteAddress : null;
}

function errorStatusCode(err: unknown): number {
  if (err && typeof err === "object" && typeof (err as { statusCode?: unknown }).statusCode === "number") {
    return (err as { statusCode: number }).statusCode;
  }
  return 500;
}

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

  let result;
  try {
    result = await startLogin(provider);
  } catch (err) {
    return json(res, errorStatusCode(err), { error: "oidc_error", message: errorMessage(err) });
  }

  res.setHeader("Set-Cookie", buildFlowCookie(result.flowState));
  res.writeHead(302, { Location: result.authorizeUrl });
  res.end();
  return;
};

function redirectAfterLogin(res: ServerResponse, target = "/dashboard", sessionCookie: string | null = null): void {
  const headers: Record<string, string | string[]> = { Location: target };
  if (sessionCookie) {
    headers["Set-Cookie"] = sessionCookie;
  }
  res.writeHead(302, headers);
  res.end();
}

const handleCallback: RouteHandlerWithUrl = async (req, res, requestUrl) => {
  const flowState = readFlowCookie(req);
  if (!flowState) {
    return json(res, 400, { error: "bad_request", message: "missing or expired OIDC flow state" });
  }

  const provider = await findProviderById(flowState.provider_id, { withSecret: true });
  if (!provider || !provider.enabled) {
    res.setHeader("Set-Cookie", buildClearFlowCookie());
    return json(res, 404, { error: "not_found", message: "auth provider no longer available" });
  }

  // Build the full callback URL openid-client expects (origin + path + query).
  const host = req.headers["x-forwarded-host"] || req.headers.host || "localhost";
  const proto = req.headers["x-forwarded-proto"] || (req.socket && (req.socket as { encrypted?: boolean }).encrypted ? "https" : "http");
  const currentUrl = `${proto}://${host}${requestUrl.pathname}${requestUrl.search}`;

  const ipAddress = clientAddress(req);
  const userAgent = req.headers["user-agent"] || null;

  // AUTH-015: replay protection. Mark the state as consumed BEFORE running
  // the token exchange so a concurrent replay can't sneak in. If the state
  // hash is already on file we abort with a 400 and record a security
  // event.
  const stateExpiresAt = new Date(Date.now() + 15 * 60 * 1000);
  const recorded = await recordUsedState({ state: flowState.state, providerId: provider.id, expiresAt: stateExpiresAt })
    .catch((err): { replayed: boolean; ok: boolean; reason: string } => ({
      replayed: false,
      ok: false,
      reason: errorMessage(err)
    }));
  if (recorded.replayed) {
    res.setHeader("Set-Cookie", buildClearFlowCookie());
    await writeEvent({
      action: "auth.security.state_replay_blocked",
      outcome: "failure",
      details: { method: "oidc", provider: provider.name, reason: recorded.reason || "state_replayed" },
      ipAddress,
      userAgent
    })
      .catch(() => {});
    return json(res, 400, {
      error: "bad_request",
      code: "state_replayed",
      message: "this authorization response has already been processed"
    });
  }

  let principal;
  try {
    principal = await completeLogin(provider, currentUrl, flowState);
  } catch (err) {
    res.setHeader("Set-Cookie", buildClearFlowCookie());
    const message = errorMessage(err);
    await writeEvent({
      action: "auth.login.failure",
      outcome: "failure",
      details: { method: "oidc", provider: provider.name, reason: message || "oidc_error" },
      ipAddress,
      userAgent
    })
      .catch(() => {});
    return json(res, errorStatusCode(err), { error: "oidc_error", message });
  }

  // AUTH-012: resolve the IdP principal to a local user, applying account
  // linking + JIT provisioning rules. The resolver itself records the
  // identity-side audit events (linked / provisioned / rejected).
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
        method: "oidc",
        provider: provider.name,
        reason: resolution.code
      },
      ipAddress,
      userAgent
    })
      .catch(() => {});
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
    details: { method: "oidc", provider: provider.name, mode: resolution.mode },
    ipAddress,
    userAgent
  })
    .catch(() => {});

  const sessionCookie = buildSessionCookie(session.token, session.expiresAt);
  const clearFlowCookie = buildClearFlowCookie();

  // Browsers accept multiple Set-Cookie headers but Node's writeHead expects an
  // array for duplicate header names.
  res.setHeader("Set-Cookie", [sessionCookie, clearFlowCookie]);
  return redirectAfterLogin(res, "/dashboard");
};

// Exposed for use by AUTH-009 (admin "test connection" button) and tests.
const handleStartLoginJson: RouteHandlerWithUrl = async (_req, res, requestUrl) => {
  const providerId = requestUrl.searchParams.get("provider_id");
  if (!providerId) {
    return badRequest(res, "provider_id query parameter is required");
  }
  const provider = await findProviderById(providerId, { withSecret: true });
  if (!provider || !provider.enabled) {
    return json(res, 404, { error: "not_found", message: "auth provider not found or disabled" });
  }
  try {
    const result = await startLogin(provider);
    res.setHeader("Set-Cookie", buildFlowCookie(result.flowState));
    return json(res, 200, { authorize_url: result.authorizeUrl });
  } catch (err) {
    return json(res, errorStatusCode(err), { error: "oidc_error", message: errorMessage(err) });
  }
};

export {
  handleListEnabledProviders,
  handleStartLogin,
  handleStartLoginJson,
  handleCallback,
  // Re-exported so the logout handler can clear the auxiliary cookie too.
  buildClearFlowCookie,
  buildClearSessionCookie
};
