// AUTH-007: user-scoped prompt preset routes.
//
// All four endpoints sit under `/v1/users/me/prompt-presets`. The route
// policy enforces `users.read_self` (GET) or `users.write_self` (POST,
// PUT, DELETE) — the same permissions AUTH-006 granted to every system
// role. Ownership for mutate verbs is enforced inside the service.

import type { ServerResponse } from "http";
import type { AuthedRequest } from "../lib/authGate";
import { json, readJsonBody } from "../lib/http";
import { isUuid } from "../lib/validation";
import { listForUser, createPreset, updatePreset, deletePreset } from "../services/promptPresetService";

async function handleList(req: AuthedRequest, res: ServerResponse): Promise<void> {
  const userId = req.user && req.user.id;
  const items = await listForUser({ userId, includeShared: true });
  return json(res, 200, { items });
}

async function handleCreate(req: AuthedRequest, res: ServerResponse): Promise<void> {
  const userId = req.user && req.user.id;
  const body = await readJsonBody(req).catch(() => null);
  const result = await createPreset({ ownerUserId: userId, body });
  return json(res, result.statusCode, result.body);
}

async function handleUpdate(req: AuthedRequest, res: ServerResponse, id: string): Promise<void> {
  if (!isUuid(id)) {
    return json(res, 400, { error: "bad_request", message: "preset id must be a uuid" });
  }
  const userId = req.user && req.user.id;
  const body = await readJsonBody(req).catch(() => null);
  const result = await updatePreset({ ownerUserId: userId, id, body });
  return json(res, result.statusCode, result.body);
}

async function handleDelete(req: AuthedRequest, res: ServerResponse, id: string): Promise<void> {
  if (!isUuid(id)) {
    return json(res, 400, { error: "bad_request", message: "preset id must be a uuid" });
  }
  const userId = req.user && req.user.id;
  const result = await deletePreset({ ownerUserId: userId, id });
  return json(res, result.statusCode, result.body);
}

export {
  handleList,
  handleCreate,
  handleUpdate,
  handleDelete
};
