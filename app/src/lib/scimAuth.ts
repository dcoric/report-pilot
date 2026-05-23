// AUTH-013: bearer-token auth for /scim/v2/* routes. Distinct from the
// session-cookie path used everywhere else — SCIM clients are services,
// not browsers, and present an `Authorization: Bearer <token>` header.
//
// Returns `null` (and writes a SCIM-shaped error response) when the
// request is unauthenticated; otherwise returns the matched token record
// so the route can attribute SCIM activity to the bound provider.

import type { IncomingMessage, ServerResponse } from "http";

export interface ScimTokenRecord {
  id: string;
  provider_id: string;
  label: string | null;
  created_at: string | Date;
  last_used_at: string | Date | null;
  revoked_at: string | Date | null;
}

interface ScimTokenService {
  verifyToken(presented: string): Promise<ScimTokenRecord | null>;
}

const scimTokenService = require("../services/scimTokenService") as ScimTokenService;

export interface ScimErrorBody {
  schemas: string[];
  status: string;
  detail: string;
}

function buildScimErrorBody(status: number, detail: string): ScimErrorBody {
  return {
    schemas: ["urn:ietf:params:scim:api:messages:2.0:Error"],
    status: String(status),
    detail
  };
}

export function writeScimError(res: ServerResponse, status: number, detail: string): void {
  res.writeHead(status, { "Content-Type": "application/scim+json" });
  res.end(JSON.stringify(buildScimErrorBody(status, detail)));
}

export function parseBearer(req: IncomingMessage): string | null {
  const header = req.headers && req.headers.authorization;
  if (typeof header !== "string") return null;
  const match = header.match(/^\s*Bearer\s+([A-Za-z0-9_\-.~+=/]+)\s*$/);
  return match ? match[1] : null;
}

export async function authenticateScim(req: IncomingMessage, res: ServerResponse): Promise<ScimTokenRecord | null> {
  const token = parseBearer(req);
  if (!token) {
    writeScimError(res, 401, "Bearer token required");
    return null;
  }
  const record = await scimTokenService.verifyToken(token);
  if (!record) {
    writeScimError(res, 401, "Invalid or revoked SCIM token");
    return null;
  }
  return record;
}
