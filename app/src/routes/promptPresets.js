// AUTH-007: user-scoped prompt preset routes.
//
// All four endpoints sit under `/v1/users/me/prompt-presets`. The route
// policy enforces `users.read_self` (GET) or `users.write_self` (POST,
// PUT, DELETE) — the same permissions AUTH-006 granted to every system
// role. Ownership for mutate verbs is enforced inside the service.

const { json, readJsonBody } = require("../lib/http");
const { isUuid } = require("../lib/validation");
const promptPresetService = require("../services/promptPresetService");

async function handleList(req, res) {
  const userId = req.user && req.user.id;
  const items = await promptPresetService.listForUser({ userId, includeShared: true });
  return json(res, 200, { items });
}

async function handleCreate(req, res) {
  const userId = req.user && req.user.id;
  const body = await readJsonBody(req).catch(() => null);
  const result = await promptPresetService.createPreset({ ownerUserId: userId, body });
  return json(res, result.statusCode, result.body);
}

async function handleUpdate(req, res, id) {
  if (!isUuid(id)) {
    return json(res, 400, { error: "bad_request", message: "preset id must be a uuid" });
  }
  const userId = req.user && req.user.id;
  const body = await readJsonBody(req).catch(() => null);
  const result = await promptPresetService.updatePreset({ ownerUserId: userId, id, body });
  return json(res, result.statusCode, result.body);
}

async function handleDelete(req, res, id) {
  if (!isUuid(id)) {
    return json(res, 400, { error: "bad_request", message: "preset id must be a uuid" });
  }
  const userId = req.user && req.user.id;
  const result = await promptPresetService.deletePreset({ ownerUserId: userId, id });
  return json(res, result.statusCode, result.body);
}

module.exports = {
  handleList,
  handleCreate,
  handleUpdate,
  handleDelete
};
