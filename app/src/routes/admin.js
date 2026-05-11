const { json, readJsonBody, badRequest } = require("../lib/http");
const { isUuid } = require("../lib/validation");
const adminUserService = require("../services/adminUserService");

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

module.exports = {
  handleListUsers,
  handleCreateUser,
  handleUpdateUserRoles
};
