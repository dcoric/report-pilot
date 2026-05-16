// AUTH-006: per-user configuration profile routes.
//
// Both endpoints require an authenticated user (the route policy enforces
// the `users.read_self` / `users.write_self` permissions). req.user is
// guaranteed to be populated by lib/authGate.enforcePolicy before these
// handlers run.

const { json, readJsonBody } = require("../lib/http");
const userConfigService = require("../services/userConfigService");

async function handleGetConfig(req, res) {
  const userId = req.user && req.user.id;
  const config = await userConfigService.getConfig(userId);
  return json(res, 200, { config });
}

async function handlePutConfig(req, res) {
  const userId = req.user && req.user.id;
  const body = await readJsonBody(req).catch(() => null);
  const result = await userConfigService.putConfig(userId, body);
  if (result.statusCode === 200) {
    return json(res, 200, { config: result.body });
  }
  return json(res, result.statusCode, result.body);
}

module.exports = {
  handleGetConfig,
  handlePutConfig
};
