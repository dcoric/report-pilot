const { json, readJsonBody, badRequest } = require("../lib/http");
const { isUuid } = require("../lib/validation");
const appDb = require("../lib/appDb");
const adminUserService = require("../services/adminUserService");
const dataSourceAccessService = require("../services/dataSourceAccessService");
const authProviderService = require("../services/authProviderService");

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
  const result = await authProviderService.upsertProvider(body);
  return json(res, result.statusCode, result.body);
}

async function handleDeleteAuthProvider(_req, res, providerId) {
  if (!isUuid(providerId)) {
    return badRequest(res, "provider id must be a uuid");
  }
  const result = await authProviderService.deleteProvider(providerId);
  return json(res, result.statusCode, result.body);
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
  handleDeleteAuthProvider
};
