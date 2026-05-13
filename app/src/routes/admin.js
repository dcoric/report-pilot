const { json, readJsonBody, badRequest } = require("../lib/http");
const { isUuid } = require("../lib/validation");
const appDb = require("../lib/appDb");
const adminUserService = require("../services/adminUserService");
const dataSourceAccessService = require("../services/dataSourceAccessService");
const authProviderService = require("../services/authProviderService");
const auditService = require("../services/auditService");
const linkedIdentityService = require("../services/linkedIdentityService");
const oidcService = require("../services/oidcService");

function writeResult(res, result) {
  return json(res, result.statusCode, result.body);
}

async function handleListUsers(_req, res) {
  const result = await adminUserService.listUsers();
  return writeResult(res, result);
}

async function handleCreateUser(req, res) {
  const body = await readJsonBody(req);
  const result = await adminUserService.createUser({
    email: body.email,
    password: body.password,
    displayName: body.display_name,
    roles: body.roles,
    actorUserId: req.user && req.user.id ? req.user.id : null
  });
  return writeResult(res, result);
}

async function handleUpdateUserRoles(req, res, userId) {
  if (!isUuid(userId)) {
    return badRequest(res, "user id must be a uuid");
  }
  const body = await readJsonBody(req);
  const result = await adminUserService.updateUserRoles({
    userId,
    assign: body.assign,
    revoke: body.revoke,
    actorUserId: req.user && req.user.id ? req.user.id : null
  });
  return writeResult(res, result);
}

async function dataSourceExists(dataSourceId) {
  const result = await appDb.query("SELECT id FROM data_sources WHERE id = $1", [dataSourceId]);
  return result.rowCount > 0;
}

async function userExists(userId) {
  const result = await appDb.query("SELECT id FROM users WHERE id = $1", [userId]);
  return result.rowCount > 0;
}

async function handleListDataSourceAccess(_req, res, dataSourceId) {
  if (!isUuid(dataSourceId)) {
    return badRequest(res, "data_source_id must be a uuid");
  }
  if (!(await dataSourceExists(dataSourceId))) {
    return json(res, 404, { error: "not_found", message: "data source not found" });
  }
  const items = await dataSourceAccessService.listUsersWithAccess(dataSourceId);
  return json(res, 200, { items });
}

async function handleGrantDataSourceAccess(req, res, dataSourceId) {
  if (!isUuid(dataSourceId)) {
    return badRequest(res, "data_source_id must be a uuid");
  }
  const body = await readJsonBody(req);
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
    dataSourceAccessService.grantAccess(client, {
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
}

async function handleRevokeDataSourceAccess(req, res, dataSourceId, userId) {
  if (!isUuid(dataSourceId)) {
    return badRequest(res, "data_source_id must be a uuid");
  }
  if (!isUuid(userId)) {
    return badRequest(res, "user_id must be a uuid");
  }
  const changed = await appDb.withTransaction((client) => (
    dataSourceAccessService.revokeAccess(client, {
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

async function handleListAuthProviders(_req, res) {
  const items = await authProviderService.listProviders();
  return json(res, 200, { items });
}

async function handleUpsertAuthProvider(req, res) {
  const body = await readJsonBody(req);
  const result = await authProviderService.upsertProvider(body, {
    actorUserId: req.user && req.user.id ? req.user.id : null
  });
  return json(res, result.statusCode, result.body);
}

async function handleDeleteAuthProvider(req, res, providerId) {
  if (!isUuid(providerId)) {
    return badRequest(res, "provider id must be a uuid");
  }
  const result = await authProviderService.deleteProvider(providerId, {
    actorUserId: req.user && req.user.id ? req.user.id : null
  });
  return json(res, result.statusCode, result.body);
}

async function handleListAuditEvents(req, res, requestUrl) {
  const params = requestUrl.searchParams;
  const actorUserIdRaw = params.get("actor_user_id");
  if (actorUserIdRaw && !isUuid(actorUserIdRaw)) {
    return badRequest(res, "actor_user_id must be a uuid");
  }
  const targetUserIdRaw = params.get("target_user_id");
  if (targetUserIdRaw && !isUuid(targetUserIdRaw)) {
    return badRequest(res, "target_user_id must be a uuid");
  }
  const result = await auditService.listEvents({
    action: params.get("action"),
    actorUserId: actorUserIdRaw,
    targetUserId: targetUserIdRaw,
    outcome: params.get("outcome"),
    since: params.get("since"),
    until: params.get("until"),
    limit: params.get("limit"),
    offset: params.get("offset")
  });
  return json(res, 200, result);
}

async function handleUpsertAuthProviderMappingRules(req, res, providerId) {
  if (!isUuid(providerId)) {
    return badRequest(res, "provider id must be a uuid");
  }
  const body = await readJsonBody(req);
  const result = await authProviderService.updateMappingRules(providerId, body, {
    actorUserId: req.user && req.user.id ? req.user.id : null
  });
  return json(res, result.statusCode, result.body);
}

async function handleListUserLinkedIdentities(_req, res, userId) {
  if (!isUuid(userId)) {
    return badRequest(res, "user id must be a uuid");
  }
  const userRow = await appDb.query("SELECT id FROM users WHERE id = $1", [userId]);
  if (userRow.rowCount === 0) {
    return json(res, 404, { error: "not_found", message: "user not found" });
  }
  const items = await linkedIdentityService.listForUser(userId);
  return json(res, 200, { items });
}

async function handleDeleteUserLinkedIdentity(req, res, userId, providerId) {
  if (!isUuid(userId)) {
    return badRequest(res, "user id must be a uuid");
  }
  if (!isUuid(providerId)) {
    return badRequest(res, "provider id must be a uuid");
  }
  const removed = await linkedIdentityService.unlink({ userId, providerId });
  if (!removed) {
    return json(res, 404, { error: "not_found", message: "no linked identity for that user / provider" });
  }
  await auditService
    .writeEvent({
      actorUserId: req.user && req.user.id ? req.user.id : null,
      targetUserId: userId,
      action: "auth.identity.unlinked",
      outcome: "success",
      details: { provider_id: providerId, subject: removed.subject }
    })
    .catch(() => {});
  return json(res, 200, { ok: true, user_id: userId, provider_id: providerId });
}

async function handleTestAuthProvider(_req, res, providerId) {
  if (!isUuid(providerId)) {
    return badRequest(res, "provider id must be a uuid");
  }
  const provider = await authProviderService.findProviderById(providerId, { withSecret: true });
  if (!provider) {
    return json(res, 404, { error: "not_found", message: "auth provider not found" });
  }
  const result = await oidcService.testConnection(provider);
  return json(res, 200, result);
}

module.exports = {
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
  handleListAuditEvents
};
