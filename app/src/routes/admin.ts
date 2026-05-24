import type { ServerResponse, IncomingMessage } from "http";
import type { URL } from "url";
import type { AuthedRequest } from "../lib/authGate";
import { json, readJsonBody, badRequest } from "../lib/http";
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

function writeResult(res: ServerResponse, result: { statusCode: number; body: unknown }): void {
  return json(res, result.statusCode, result.body);
}

async function handleListUsers(_req: IncomingMessage, res: ServerResponse): Promise<void> {
  const result = await listUsers();
  return writeResult(res, result);
}

async function handleCreateUser(req: AuthedRequest, res: ServerResponse): Promise<void> {
  const body = await readJsonBody(req);
  const result = await createUser({
    email: (body as Record<string, unknown>).email,
    password: (body as Record<string, unknown>).password,
    displayName: (body as Record<string, unknown>).display_name,
    roles: (body as Record<string, unknown>).roles,
    actorUserId: req.user && req.user.id ? req.user.id : null
  });
  return writeResult(res, result);
}

async function handleUpdateUserRoles(req: AuthedRequest, res: ServerResponse, userId: string): Promise<void> {
  if (!isUuid(userId)) {
    return badRequest(res, "user id must be a uuid");
  }
  const body = await readJsonBody(req);
  const result = await updateUserRoles({
    userId,
    assign: (body as Record<string, unknown>).assign,
    revoke: (body as Record<string, unknown>).revoke,
    actorUserId: req.user && req.user.id ? req.user.id : null
  });
  return writeResult(res, result);
}

async function dataSourceExists(dataSourceId: string): Promise<boolean> {
  const result = await appDb.query("SELECT id FROM data_sources WHERE id = $1", [dataSourceId]);
  return result.rowCount > 0;
}

async function userExists(userId: string): Promise<boolean> {
  const result = await appDb.query("SELECT id FROM users WHERE id = $1", [userId]);
  return result.rowCount > 0;
}

async function handleListDataSourceAccess(_req: IncomingMessage, res: ServerResponse, dataSourceId: string): Promise<void> {
  if (!isUuid(dataSourceId)) {
    return badRequest(res, "data_source_id must be a uuid");
  }
  if (!(await dataSourceExists(dataSourceId))) {
    return json(res, 404, { error: "not_found", message: "data source not found" });
  }
  const items = await listUsersWithAccess(dataSourceId);
  return json(res, 200, { items });
}

async function handleGrantDataSourceAccess(req: AuthedRequest, res: ServerResponse, dataSourceId: string): Promise<void> {
  if (!isUuid(dataSourceId)) {
    return badRequest(res, "data_source_id must be a uuid");
  }
  const body = await readJsonBody(req);
  const userId = body && (body as Record<string, unknown>).user_id;
  if (!isUuid(userId)) {
    return badRequest(res, "user_id must be a uuid");
  }
  if (!(await dataSourceExists(dataSourceId))) {
    return json(res, 404, { error: "not_found", message: "data source not found" });
  }
  if (!(await userExists(userId as string))) {
    return json(res, 404, { error: "not_found", message: "user not found" });
  }
  const changed = await appDb.withTransaction((client) => (
    grantAccess(client, {
      userId: userId as string,
      dataSourceId,
      actorUserId: req.user && req.user.id ? req.user.id : null
    })
  ));
  return json(res, changed ? 201 : 200, {
    granted: changed,
    user_id: userId,
    data_source_id: dataSourceId
  });
}

async function handleRevokeDataSourceAccess(req: AuthedRequest, res: ServerResponse, dataSourceId: string, userId: string): Promise<void> {
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
}

async function handleListAuthProviders(_req: IncomingMessage, res: ServerResponse): Promise<void> {
  const items = await listProviders();
  return json(res, 200, { items });
}

async function handleUpsertAuthProvider(req: AuthedRequest, res: ServerResponse): Promise<void> {
  const body = await readJsonBody(req);
  const result = await upsertProvider(body, {
    actorUserId: req.user && req.user.id ? req.user.id : null
  });
  return writeResult(res, result);
}

async function handleDeleteAuthProvider(req: AuthedRequest, res: ServerResponse, providerId: string): Promise<void> {
  if (!isUuid(providerId)) {
    return badRequest(res, "provider id must be a uuid");
  }
  const result = await deleteProvider(providerId, {
    actorUserId: req.user && req.user.id ? req.user.id : null
  });
  return writeResult(res, result);
}

async function handleListAuditEvents(req: AuthedRequest, res: ServerResponse, requestUrl: URL): Promise<void> {
  const params = requestUrl.searchParams;
  const actorUserIdRaw = params.get("actor_user_id");
  if (actorUserIdRaw && !isUuid(actorUserIdRaw)) {
    return badRequest(res, "actor_user_id must be a uuid");
  }
  const targetUserIdRaw = params.get("target_user_id");
  if (targetUserIdRaw && !isUuid(targetUserIdRaw)) {
    return badRequest(res, "target_user_id must be a uuid");
  }
  const result = await listEvents({
    action: params.get("action"),
    actorUserId: actorUserIdRaw,
    targetUserId: targetUserIdRaw,
    outcome: params.get("outcome"),
    since: params.get("since"),
    until: params.get("until"),
    limit: params.get("limit") as unknown as number,
    offset: params.get("offset") as unknown as number
  });
  return json(res, 200, result);
}

async function handleUpsertAuthProviderMappingRules(req: AuthedRequest, res: ServerResponse, providerId: string): Promise<void> {
  if (!isUuid(providerId)) {
    return badRequest(res, "provider id must be a uuid");
  }
  const body = await readJsonBody(req);
  const result = await updateMappingRules(providerId, body, {
    actorUserId: req.user && req.user.id ? req.user.id : null
  });
  return writeResult(res, result);
}

async function handleListUserLinkedIdentities(_req: IncomingMessage, res: ServerResponse, userId: string): Promise<void> {
  if (!isUuid(userId)) {
    return badRequest(res, "user id must be a uuid");
  }
  const userRow = await appDb.query("SELECT id FROM users WHERE id = $1", [userId]);
  if (userRow.rowCount === 0) {
    return json(res, 404, { error: "not_found", message: "user not found" });
  }
  const items = await listForUser(userId);
  return json(res, 200, { items });
}

async function handleDeleteUserLinkedIdentity(req: AuthedRequest, res: ServerResponse, userId: string, providerId: string): Promise<void> {
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
}

async function handleUpsertScimGroupMappings(req: AuthedRequest, res: ServerResponse, providerId: string): Promise<void> {
  if (!isUuid(providerId)) {
    return badRequest(res, "provider id must be a uuid");
  }
  const body = await readJsonBody(req);
  const result = await updateScimGroupMappings(providerId, body, {
    actorUserId: req.user && req.user.id ? req.user.id : null
  });
  return writeResult(res, result);
}

async function handleListScimTokens(_req: IncomingMessage, res: ServerResponse, providerId: string): Promise<void> {
  if (!isUuid(providerId)) {
    return badRequest(res, "provider id must be a uuid");
  }
  const items = await listForProvider(providerId);
  return json(res, 200, { items });
}

async function handleIssueScimToken(req: AuthedRequest, res: ServerResponse, providerId: string): Promise<void> {
  if (!isUuid(providerId)) {
    return badRequest(res, "provider id must be a uuid");
  }
  // Confirm the provider exists before issuing a token so we don't create
  // an orphan row tied to a phantom id.
  const provider = await findProviderById(providerId);
  if (!provider) {
    return json(res, 404, { error: "not_found", message: "auth provider not found" });
  }
  const body = await readJsonBody(req);
  const result = await issueToken({ providerId, label: (body && (body as Record<string, unknown>).label) as string });
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
}

async function handleRevokeScimToken(req: AuthedRequest, res: ServerResponse, providerId: string, tokenId: string): Promise<void> {
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
}

async function handleTestAuthProvider(_req: IncomingMessage, res: ServerResponse, providerId: string): Promise<void> {
  if (!isUuid(providerId)) {
    return badRequest(res, "provider id must be a uuid");
  }
  const provider = await findProviderById(providerId, { withSecret: true });
  if (!provider) {
    return json(res, 404, { error: "not_found", message: "auth provider not found" });
  }
  const result = await testConnection(provider);
  return json(res, 200, result);
}

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
