import type { IncomingMessage, ServerResponse } from "http";
import { json } from "./http";
import { logEvent } from "./observability";
import { readSessionToken, buildClearSessionCookie } from "./sessionCookie";
import type { RoutePolicy } from "./routePolicy";

export interface AuthUser {
  id: string;
  email: string;
  display_name: string | null;
  is_active: boolean;
  last_login_at: string | Date | null;
  created_at: string | Date;
  updated_at: string | Date;
}

export interface ActiveSession {
  sessionId: string;
  expiresAt: string | Date;
  user: AuthUser;
}

interface AuthService {
  findActiveSession(token: string): Promise<ActiveSession | null>;
}

interface RoleService {
  listRoleNamesForUser(userId: string): Promise<string[]>;
  listPermissionNamesForUser(userId: string): Promise<string[]>;
}

interface DataSourceAccessService {
  hasAccess(userId: string, dataSourceId: string): Promise<boolean>;
  listAccessibleDataSourceIds(userId: string): Promise<string[]>;
}

const authService = require("../services/authService") as AuthService;
const roleService = require("../services/roleService") as RoleService;
const dataSourceAccessService = require("../services/dataSourceAccessService") as DataSourceAccessService;

export interface AuthedRequest extends IncomingMessage {
  requestId?: string;
  user?: AuthUser;
  userRoles?: string[];
  userPermissions?: string[];
}

export interface CurrentUserExpired {
  expired: true;
}

export interface CurrentUserActive {
  user: AuthUser;
  roles: string[];
  sessionId: string;
  expiresAt: string | Date;
  expired?: false;
}

export type CurrentUser = CurrentUserActive | CurrentUserExpired;

export async function loadCurrentUser(req: AuthedRequest): Promise<CurrentUser | null> {
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

interface LogDecisionArgs {
  req: AuthedRequest;
  decision: string;
  userId: string | null;
  policy: RoutePolicy | null;
}

function logDecision({ req, decision, userId, policy }: LogDecisionArgs): void {
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

export async function requireAuthenticated(req: AuthedRequest, res: ServerResponse): Promise<CurrentUserActive | null> {
  const current = await loadCurrentUser(req);
  if (!current) {
    json(res, 401, { error: "unauthenticated" });
    return null;
  }
  if ((current as CurrentUserExpired).expired) {
    res.setHeader("Set-Cookie", buildClearSessionCookie());
    json(res, 401, { error: "unauthenticated" });
    return null;
  }
  return current as CurrentUserActive;
}

export async function requireRole(req: AuthedRequest, res: ServerResponse, roleName: string): Promise<CurrentUserActive | null> {
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

export interface EnforcePolicyResult {
  allowed: boolean;
  user?: AuthUser;
  roles?: string[];
  permissions?: string[] | null;
}

// Central enforcement used by the HTTP dispatcher. Returns { allowed: bool }.
// On deny, the response has already been written.
export async function enforcePolicy(req: AuthedRequest, res: ServerResponse, policy: RoutePolicy | null): Promise<EnforcePolicyResult> {
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
  if ((current as CurrentUserExpired).expired) {
    res.setHeader("Set-Cookie", buildClearSessionCookie());
    logDecision({ req, decision: "deny_expired_session", userId: null, policy });
    json(res, 401, { error: "unauthenticated" });
    return { allowed: false };
  }

  const active = current as CurrentUserActive;

  if (policy.role && !active.roles.includes(policy.role)) {
    logDecision({ req, decision: "deny_role", userId: active.user.id, policy });
    json(res, 403, { error: "forbidden", message: `requires role: ${policy.role}` });
    return { allowed: false };
  }

  let permissions: string[] | null = null;
  if (policy.permission) {
    permissions = await roleService.listPermissionNamesForUser(active.user.id);
    if (!permissions.includes(policy.permission)) {
      logDecision({ req, decision: "deny_permission", userId: active.user.id, policy });
      json(res, 403, { error: "forbidden", message: `requires permission: ${policy.permission}` });
      return { allowed: false };
    }
  }

  req.user = active.user;
  req.userRoles = active.roles;
  if (permissions !== null) {
    req.userPermissions = permissions;
  }
  logDecision({ req, decision: "allow", userId: active.user.id, policy });
  return { allowed: true, user: active.user, roles: active.roles, permissions };
}

export function isAdmin(req: AuthedRequest): boolean {
  return Boolean(req.userRoles && req.userRoles.includes("admin"));
}

// Returns true and allows the request to continue. On deny the response has
// already been written (403). The check is skipped for admins.
export async function enforceDataSourceAccess(req: AuthedRequest, res: ServerResponse, dataSourceId: string | null | undefined): Promise<boolean> {
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
export async function listAccessibleDataSourceIds(req: AuthedRequest): Promise<string[] | null> {
  if (isAdmin(req)) {
    return null;
  }
  if (!req.user) {
    return [];
  }
  return dataSourceAccessService.listAccessibleDataSourceIds(req.user.id);
}
