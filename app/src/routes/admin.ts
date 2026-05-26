import {
  readJsonBody,
  badRequest,
  json,
  writeServiceResult,
  type RouteHandler,
  type RouteHandlerWithId,
  type RouteHandlerWithIds,
  type RouteHandlerWithUrl
} from "../lib/http";
import { isUuid } from "../lib/validation";
import appDb = require("../lib/appDb");
import { listUsers, createUser, updateUserRoles } from "../services/adminUserService";
import { listUsersWithAccess, grantAccess, revokeAccess } from "../services/dataSourceAccessService";
import {
  listProviders,
  upsertProvider,
  deleteProvider,
  findProviderById,
  updateMappingRules,
  updateScimGroupMappings
} from "../services/authProviderService";
import { listEvents, writeEvent } from "../services/auditService";
import { listForUser, unlink } from "../services/linkedIdentityService";
import { testConnection } from "../services/oidcService";
import { listForProvider, issueToken, revokeToken } from "../services/scimTokenService";
import type {
  CreateAdminUserRequest,
  UpdateUserRolesRequest,
  AuthProviderUpsertRequest,
  AuthProviderMappingRulesRequest,
  GrantDataSourceAccessRequest
} from "../types";

const handleListUsers: RouteHandler = async (_req, res) => {
  const result = await listUsers();
  return writeServiceResult(res, result);
};

const handleCreateUser: RouteHandler<CreateAdminUserRequest> = async (req, res) => {
  const body = await readJsonBody<Partial<CreateAdminUserRequest>>(req);
  const result = await createUser({
    email: body.email,
    password: body.password,
    displayName: body.display_name,
    roles: body.roles,
    actorUserId: req.user && req.user.id ? req.user.id : null
  });
  return writeServiceResult(res, result);
};

const handleUpdateUserRoles: RouteHandlerWithId<UpdateUserRolesRequest> = async (req, res, userId) => {
  if (!isUuid(userId)) {
    return badRequest(res, "user id must be a uuid");
  }
  const body = await readJsonBody<Partial<UpdateUserRolesRequest>>(req);
  const result = await updateUserRoles({
    userId,
    assign: body.assign,
    revoke: body.revoke,
    actorUserId: req.user && req.user.id ? req.user.id : null
  });
  return writeServiceResult(res, result);
};

async function dataSourceExists(dataSourceId: string): Promise<boolean> {
  const result = await appDb.query("SELECT id FROM data_sources WHERE id = $1", [dataSourceId]);
  return (result.rowCount ?? 0) > 0;
}

async function userExists(userId: string): Promise<boolean> {
  const result = await appDb.query("SELECT id FROM users WHERE id = $1", [userId]);
  return (result.rowCount ?? 0) > 0;
}

const handleListDataSourceAccess: RouteHandlerWithId = async (_req, res, dataSourceId) => {
  if (!isUuid(dataSourceId)) {
    return badRequest(res, "data_source_id must be a uuid");
  }
  if (!(await dataSourceExists(dataSourceId))) {
    return json(res, 404, { error: "not_found", message: "data source not found" });
  }
  const items = await listUsersWithAccess(dataSourceId);
  return json(res, 200, { items });
};

const handleGrantDataSourceAccess: RouteHandlerWithId<GrantDataSourceAccessRequest> = async (req, res, dataSourceId) => {
  if (!isUuid(dataSourceId)) {
    return badRequest(res, "data_source_id must be a uuid");
  }
  const body = await readJsonBody<Partial<GrantDataSourceAccessRequest>>(req);
  const userId = body && body.user_id;
  if (!isUuid(userId)) {
    return badRequest(res, "user_id must be a uuid");
  }
  if (!(await dataSourceExists(dataSourceId))) {
    return json(res, 404, { error: "not_found", message: "data source not found" });
  }
  if (!(await userExists(userId))) {
    return json(res, 404, { error: "not_found", message: "user not found" });
  }
  const changed = await appDb.withTransaction((client) => (
    grantAccess(client, {
      userId,
      dataSourceId,
      actorUserId: req.user && req.user.id ? req.user.id : null
    })
  ));
  return json(res, changed ? 201 : 200, {
    granted: changed,
    user_id: userId,
    data_source_id: dataSourceId
  });
};

const handleRevokeDataSourceAccess: RouteHandlerWithIds = async (req, res, dataSourceId, userId) => {
  if (!isUuid(dataSourceId)) {
    return badRequest(res, "data_source_id must be a uuid");
  }
  if (!isUuid(userId)) {
    return badRequest(res, "user_id must be a uuid");
  }
  const changed = await appDb.withTransaction((client) => (
    revokeAccess(client, {
      userId,
      dataSourceId,
      actorUserId: req.user && req.user.id ? req.user.id : null
    })
  ));
  if (!changed) {
    return json(res, 404, { error: "not_found", message: "no access grant found for that user / data source" });
  }
  return json(res, 200, {
    revoked: true,
    user_id: userId,
    data_source_id: dataSourceId
  });
};

const handleListAuthProviders: RouteHandler = async (_req, res) => {
  const items = await listProviders();
  return json(res, 200, { items });
};

const handleUpsertAuthProvider: RouteHandler<AuthProviderUpsertRequest> = async (req, res) => {
  const body = await readJsonBody<Partial<AuthProviderUpsertRequest>>(req);
  const result = await upsertProvider(body, {
    actorUserId: req.user && req.user.id ? req.user.id : null
  });
  return writeServiceResult(res, result);
};

const handleDeleteAuthProvider: RouteHandlerWithId = async (req, res, providerId) => {
  if (!isUuid(providerId)) {
    return badRequest(res, "provider id must be a uuid");
  }
  const result = await deleteProvider(providerId, {
    actorUserId: req.user && req.user.id ? req.user.id : null
  });
  return writeServiceResult(res, result);
};

const handleListAuditEvents: RouteHandlerWithUrl = async (req, res, requestUrl) => {
  const params = requestUrl.searchParams;
  const actorUserIdRaw = params.get("actor_user_id");
  if (actorUserIdRaw && !isUuid(actorUserIdRaw)) {
    return badRequest(res, "actor_user_id must be a uuid");
  }
  const targetUserIdRaw = params.get("target_user_id");
  if (targetUserIdRaw && !isUuid(targetUserIdRaw)) {
    return badRequest(res, "target_user_id must be a uuid");
  }
  const limitRaw = params.get("limit");
  const offsetRaw = params.get("offset");
  const result = await listEvents({
    action: params.get("action"),
    actorUserId: actorUserIdRaw,
    targetUserId: targetUserIdRaw,
    outcome: params.get("outcome"),
    since: params.get("since"),
    until: params.get("until"),
    limit: limitRaw === null ? undefined : Number(limitRaw),
    offset: offsetRaw === null ? undefined : Number(offsetRaw)
  });
  return json(res, 200, result);
};

const handleUpsertAuthProviderMappingRules: RouteHandlerWithId<AuthProviderMappingRulesRequest> = async (req, res, providerId) => {
  if (!isUuid(providerId)) {
    return badRequest(res, "provider id must be a uuid");
  }
  const body = await readJsonBody<AuthProviderMappingRulesRequest>(req);
  const result = await updateMappingRules(providerId, body, {
    actorUserId: req.user && req.user.id ? req.user.id : null
  });
  return writeServiceResult(res, result);
};

const handleListUserLinkedIdentities: RouteHandlerWithId = async (_req, res, userId) => {
  if (!isUuid(userId)) {
    return badRequest(res, "user id must be a uuid");
  }
  const userRow = await appDb.query("SELECT id FROM users WHERE id = $1", [userId]);
  if (userRow.rowCount === 0) {
    return json(res, 404, { error: "not_found", message: "user not found" });
  }
  const items = await listForUser(userId);
  return json(res, 200, { items });
};

const handleDeleteUserLinkedIdentity: RouteHandlerWithIds = async (req, res, userId, providerId) => {
  if (!isUuid(userId)) {
    return badRequest(res, "user id must be a uuid");
  }
  if (!isUuid(providerId)) {
    return badRequest(res, "provider id must be a uuid");
  }
  const removed = await unlink({ userId, providerId });
  if (!removed) {
    return json(res, 404, { error: "not_found", message: "no linked identity for that user / provider" });
  }
  await writeEvent({
    actorUserId: req.user && req.user.id ? req.user.id : null,
    targetUserId: userId,
    action: "auth.identity.unlinked",
    outcome: "success",
    details: { provider_id: providerId, subject: removed.subject }
  })
    .catch(() => {});
  return json(res, 200, { ok: true, user_id: userId, provider_id: providerId });
};

const handleUpsertScimGroupMappings: RouteHandlerWithId = async (req, res, providerId) => {
  if (!isUuid(providerId)) {
    return badRequest(res, "provider id must be a uuid");
  }
  const body = await readJsonBody(req);
  const result = await updateScimGroupMappings(providerId, body, {
    actorUserId: req.user && req.user.id ? req.user.id : null
  });
  return writeServiceResult(res, result);
};

const handleListScimTokens: RouteHandlerWithId = async (_req, res, providerId) => {
  if (!isUuid(providerId)) {
    return badRequest(res, "provider id must be a uuid");
  }
  const items = await listForProvider(providerId);
  return json(res, 200, { items });
};

const handleIssueScimToken: RouteHandlerWithId = async (req, res, providerId) => {
  if (!isUuid(providerId)) {
    return badRequest(res, "provider id must be a uuid");
  }
  // Confirm the provider exists before issuing a token so we don't create
  // an orphan row tied to a phantom id.
  const provider = await findProviderById(providerId);
  if (!provider) {
    return json(res, 404, { error: "not_found", message: "auth provider not found" });
  }
  const body = await readJsonBody<{ label?: string }>(req);
  const result = await issueToken({ providerId, label: typeof body.label === "string" ? body.label : "" });
  if (result.ok === false) {
    return badRequest(res, result.message);
  }
  await writeEvent({
    actorUserId: req.user && req.user.id ? req.user.id : null,
    action: "scim.token.issued",
    outcome: "success",
    details: { provider_id: providerId, token_id: result.record.id, label: result.record.label }
  })
    .catch(() => {});
  return json(res, 201, { token: result.token, record: result.record });
};

const handleRevokeScimToken: RouteHandlerWithIds = async (req, res, providerId, tokenId) => {
  if (!isUuid(providerId)) {
    return badRequest(res, "provider id must be a uuid");
  }
  if (!isUuid(tokenId)) {
    return badRequest(res, "token id must be a uuid");
  }
  const revoked = await revokeToken({ providerId, tokenId });
  if (!revoked) {
    return json(res, 404, { error: "not_found", message: "scim token not found" });
  }
  await writeEvent({
    actorUserId: req.user && req.user.id ? req.user.id : null,
    action: "scim.token.revoked",
    outcome: "success",
    details: { provider_id: providerId, token_id: tokenId }
  })
    .catch(() => {});
  return json(res, 200, { ok: true, record: revoked });
};

const handleTestAuthProvider: RouteHandlerWithId = async (_req, res, providerId) => {
  if (!isUuid(providerId)) {
    return badRequest(res, "provider id must be a uuid");
  }
  const provider = await findProviderById(providerId, { withSecret: true });
  if (!provider) {
    return json(res, 404, { error: "not_found", message: "auth provider not found" });
  }
  const result = await testConnection(provider);
  return json(res, 200, result);
};

export {
  handleListUsers,
  handleCreateUser,
  handleUpdateUserRoles,
  handleListDataSourceAccess,
  handleGrantDataSourceAccess,
  handleRevokeDataSourceAccess,
  handleListAuthProviders,
  handleUpsertAuthProvider,
  handleDeleteAuthProvider,
  handleTestAuthProvider,
  handleUpsertAuthProviderMappingRules,
  handleListUserLinkedIdentities,
  handleDeleteUserLinkedIdentity,
  handleUpsertScimGroupMappings,
  handleListScimTokens,
  handleIssueScimToken,
  handleRevokeScimToken,
  handleListAuditEvents
};
