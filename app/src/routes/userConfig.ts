// AUTH-006: per-user configuration profile routes.
//
// Both endpoints require an authenticated user (the route policy enforces
// the `users.read_self` / `users.write_self` permissions). req.user is
// guaranteed to be populated by lib/authGate.enforcePolicy before these
// handlers run.

import type { ServerResponse } from "http";
import type { AuthedRequest } from "../lib/authGate";
import { json, readJsonBody } from "../lib/http";
import { getConfig, putConfig } from "../services/userConfigService";

async function handleGetConfig(req: AuthedRequest, res: ServerResponse): Promise<void> {
  const userId = req.user && req.user.id;
  const config = await getConfig(userId);
  return json(res, 200, { config });
}

async function handlePutConfig(req: AuthedRequest, res: ServerResponse): Promise<void> {
  const userId = req.user && req.user.id;
  const body = await readJsonBody(req).catch(() => null);
  const result = await putConfig(userId, body);
  if (result.statusCode === 200) {
    return json(res, 200, { config: result.body });
  }
  return json(res, result.statusCode, result.body);
}

export {
  handleGetConfig,
  handlePutConfig
};
