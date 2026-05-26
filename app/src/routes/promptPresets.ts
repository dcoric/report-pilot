// AUTH-007: user-scoped prompt preset routes.
//
// All four endpoints sit under `/v1/users/me/prompt-presets`. The route
// policy enforces `users.read_self` (GET) or `users.write_self` (POST,
// PUT, DELETE) — the same permissions AUTH-006 granted to every system
// role. Ownership for mutate verbs is enforced inside the service.

import {
  json,
  readJsonBody,
  type RouteHandler,
  type RouteHandlerWithId
} from "../lib/http";
import { isUuid } from "../lib/validation";
import { listForUser, createPreset, updatePreset, deletePreset } from "../services/promptPresetService";
import type { PromptPreset, PromptPresetUpsertRequest } from "../types";

const handleList: RouteHandler<never, { items: PromptPreset[] }> = async (req, res) => {
  const userId = req.user && req.user.id;
  const items = await listForUser({ userId, includeShared: true });
  return json(res, 200, { items });
};

const handleCreate: RouteHandler<PromptPresetUpsertRequest, PromptPreset> = async (req, res) => {
  const userId = req.user && req.user.id;
  const body = await readJsonBody<PromptPresetUpsertRequest | null>(req).catch(() => null);
  const result = await createPreset({ ownerUserId: userId, body });
  return json(res, result.statusCode, result.body);
};

const handleUpdate: RouteHandlerWithId<PromptPresetUpsertRequest, PromptPreset> = async (req, res, id) => {
  if (!isUuid(id)) {
    return json(res, 400, { error: "bad_request", message: "preset id must be a uuid" });
  }
  const userId = req.user && req.user.id;
  const body = await readJsonBody<PromptPresetUpsertRequest | null>(req).catch(() => null);
  const result = await updatePreset({ ownerUserId: userId, id, body });
  return json(res, result.statusCode, result.body);
};

const handleDelete: RouteHandlerWithId = async (req, res, id) => {
  if (!isUuid(id)) {
    return json(res, 400, { error: "bad_request", message: "preset id must be a uuid" });
  }
  const userId = req.user && req.user.id;
  const result = await deletePreset({ ownerUserId: userId, id });
  return json(res, result.statusCode, result.body);
};

export {
  handleList,
  handleCreate,
  handleUpdate,
  handleDelete
};
