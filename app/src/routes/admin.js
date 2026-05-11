const { json, readJsonBody, badRequest } = require("../lib/http");
const { isUuid } = require("../lib/validation");
const { requireRole } = require("../lib/authGate");
const adminUserService = require("../services/adminUserService");

function writeResult(res, result) {
  return json(res, result.statusCode, result.body);
}

async function handleListUsers(req, res) {
  const current = await requireRole(req, res, "admin");
  if (!current) return undefined;
  const result = await adminUserService.listUsers();
  return writeResult(res, result);
}

async function handleCreateUser(req, res) {
  const current = await requireRole(req, res, "admin");
  if (!current) return undefined;
  const body = await readJsonBody(req);
  const result = await adminUserService.createUser({
    email: body.email,
    password: body.password,
    displayName: body.display_name,
    roles: body.roles,
    actorUserId: current.user.id
  });
  return writeResult(res, result);
}

async function handleUpdateUserRoles(req, res, userId) {
  const current = await requireRole(req, res, "admin");
  if (!current) return undefined;
  if (!isUuid(userId)) {
    return badRequest(res, "user id must be a uuid");
  }
  const body = await readJsonBody(req);
  const result = await adminUserService.updateUserRoles({
    userId,
    assign: body.assign,
    revoke: body.revoke,
    actorUserId: current.user.id
  });
  return writeResult(res, result);
}

module.exports = {
  handleListUsers,
  handleCreateUser,
  handleUpdateUserRoles
};
