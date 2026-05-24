// AUTH-013: SCIM 2.0 protocol surface.
//
// Routes:
//   GET    /scim/v2/ServiceProviderConfig
//   GET    /scim/v2/ResourceTypes
//   GET    /scim/v2/Schemas
//   GET    /scim/v2/Users
//   POST   /scim/v2/Users
//   GET    /scim/v2/Users/{id}
//   PUT    /scim/v2/Users/{id}
//   PATCH  /scim/v2/Users/{id}
//   DELETE /scim/v2/Users/{id}
//   GET    /scim/v2/Groups
//   POST   /scim/v2/Groups
//   PATCH  /scim/v2/Groups/{id}
//
// Every route is bearer-authenticated via lib/scimAuth. Responses use the
// `application/scim+json` content type as required by RFC 7644.

import type { ServerResponse } from "http";
import type { URL } from "url";
import type { AuthedRequest } from "../lib/authGate";
import { readJsonBody } from "../lib/http";
import { authenticateScim, writeScimError } from "../lib/scimAuth";
import * as scimUserService from "../services/scimUserService";
import * as scimGroupService from "../services/scimGroupService";

function scimJson(res: ServerResponse, statusCode: number, body: unknown): void {
  if (statusCode === 204 || body == null) {
    res.writeHead(204);
    res.end();
    return;
  }
  res.writeHead(statusCode, { "Content-Type": "application/scim+json" });
  res.end(JSON.stringify(body));
}

function clientAddress(req: AuthedRequest): string | null {
  const fwd = req.headers["x-forwarded-for"];
  if (typeof fwd === "string" && fwd.length > 0) {
    const first = fwd.split(",")[0];
    if (first) return first.trim();
  }
  return req.socket && req.socket.remoteAddress ? req.socket.remoteAddress : null;
}

function serviceProviderConfig() {
  return {
    schemas: ["urn:ietf:params:scim:schemas:core:2.0:ServiceProviderConfig"],
    documentationUri: "https://datatracker.ietf.org/doc/html/rfc7643",
    patch: { supported: true },
    bulk: { supported: false, maxOperations: 0, maxPayloadSize: 0 },
    filter: { supported: true, maxResults: 200 },
    changePassword: { supported: false },
    sort: { supported: false },
    etag: { supported: false },
    authenticationSchemes: [
      {
        type: "oauthbearertoken",
        name: "OAuth Bearer Token",
        description: "Per-provider opaque bearer token managed by the admin UI."
      }
    ]
  };
}

function resourceTypes() {
  return {
    schemas: ["urn:ietf:params:scim:api:messages:2.0:ListResponse"],
    totalResults: 2,
    Resources: [
      {
        schemas: ["urn:ietf:params:scim:schemas:core:2.0:ResourceType"],
        id: "User",
        name: "User",
        endpoint: "/Users",
        schema: "urn:ietf:params:scim:schemas:core:2.0:User"
      },
      {
        schemas: ["urn:ietf:params:scim:schemas:core:2.0:ResourceType"],
        id: "Group",
        name: "Group",
        endpoint: "/Groups",
        schema: "urn:ietf:params:scim:schemas:core:2.0:Group"
      }
    ]
  };
}

function schemas() {
  return {
    schemas: ["urn:ietf:params:scim:api:messages:2.0:ListResponse"],
    totalResults: 2,
    Resources: [
      { id: "urn:ietf:params:scim:schemas:core:2.0:User", name: "User" },
      { id: "urn:ietf:params:scim:schemas:core:2.0:Group", name: "Group" }
    ]
  };
}

async function handleServiceProviderConfig(req: AuthedRequest, res: ServerResponse): Promise<void> {
  const token = await authenticateScim(req, res);
  if (!token) return;
  return scimJson(res, 200, serviceProviderConfig());
}

async function handleResourceTypes(req: AuthedRequest, res: ServerResponse): Promise<void> {
  const token = await authenticateScim(req, res);
  if (!token) return;
  return scimJson(res, 200, resourceTypes());
}

async function handleSchemas(req: AuthedRequest, res: ServerResponse): Promise<void> {
  const token = await authenticateScim(req, res);
  if (!token) return;
  return scimJson(res, 200, schemas());
}

async function handleListUsers(req: AuthedRequest, res: ServerResponse, requestUrl: URL): Promise<void> {
  const token = await authenticateScim(req, res);
  if (!token) return;
  const params = requestUrl.searchParams;
  const result = await scimUserService.listUsers({
    providerId: token.provider_id,
    filter: params.get("filter"),
    startIndex: (params.get("startIndex") || 1) as number,
    count: (params.get("count") || 100) as number
  });
  return scimJson(res, 200, result);
}

async function handleCreateUser(req: AuthedRequest, res: ServerResponse): Promise<void> {
  const token = await authenticateScim(req, res);
  if (!token) return;
  let body: any;
  try {
    body = await readJsonBody(req);
  } catch {
    return writeScimError(res, 400, "request body is not valid JSON");
  }
  const result = await scimUserService.createUser({
    providerId: token.provider_id,
    body,
    ipAddress: clientAddress(req),
    userAgent: req.headers["user-agent"] || null
  });
  return scimJson(res, result.statusCode, result.body);
}

async function handleGetUser(req: AuthedRequest, res: ServerResponse, userId: string): Promise<void> {
  const token = await authenticateScim(req, res);
  if (!token) return;
  const result = await scimUserService.getUser({ providerId: token.provider_id, userId });
  return scimJson(res, result.statusCode, result.body);
}

async function handleReplaceUser(req: AuthedRequest, res: ServerResponse, userId: string): Promise<void> {
  const token = await authenticateScim(req, res);
  if (!token) return;
  const body = await readJsonBody(req).catch(() => null) as Record<string, unknown> | null;
  const result = await scimUserService.replaceUser({
    providerId: token.provider_id,
    userId,
    body,
    ipAddress: clientAddress(req),
    userAgent: req.headers["user-agent"] || null
  });
  return scimJson(res, result.statusCode, result.body);
}

async function handlePatchUser(req: AuthedRequest, res: ServerResponse, userId: string): Promise<void> {
  const token = await authenticateScim(req, res);
  if (!token) return;
  const body = await readJsonBody(req).catch(() => null) as Record<string, unknown> | null;
  const result = await scimUserService.patchUser({
    providerId: token.provider_id,
    userId,
    body,
    ipAddress: clientAddress(req),
    userAgent: req.headers["user-agent"] || null
  });
  return scimJson(res, result.statusCode, result.body);
}

async function handleDeleteUser(req: AuthedRequest, res: ServerResponse, userId: string): Promise<void> {
  const token = await authenticateScim(req, res);
  if (!token) return;
  const result = await scimUserService.deleteUser({
    providerId: token.provider_id,
    userId,
    ipAddress: clientAddress(req),
    userAgent: req.headers["user-agent"] || null
  });
  return scimJson(res, result.statusCode, result.body);
}

async function handleListGroups(req: AuthedRequest, res: ServerResponse): Promise<void> {
  const token = await authenticateScim(req, res);
  if (!token) return;
  const result = scimGroupService.listGroups();
  return scimJson(res, result.statusCode, result.body);
}

async function handleCreateOrReplaceGroup(req: AuthedRequest, res: ServerResponse): Promise<void> {
  const token = await authenticateScim(req, res);
  if (!token) return;
  const body = await readJsonBody(req).catch(() => null) as Record<string, unknown> | null;
  const result = await scimGroupService.createOrReplaceGroup({
    providerId: token.provider_id,
    body
  });
  return scimJson(res, result.statusCode, result.body);
}

async function handlePatchGroup(req: AuthedRequest, res: ServerResponse): Promise<void> {
  const token = await authenticateScim(req, res);
  if (!token) return;
  const body = await readJsonBody(req).catch(() => null) as Record<string, unknown> | null;
  const result = await scimGroupService.patchGroup({
    providerId: token.provider_id,
    body
  });
  return scimJson(res, result.statusCode, result.body);
}

export {
  handleServiceProviderConfig,
  handleResourceTypes,
  handleSchemas,
  handleListUsers,
  handleCreateUser,
  handleGetUser,
  handleReplaceUser,
  handlePatchUser,
  handleDeleteUser,
  handleListGroups,
  handleCreateOrReplaceGroup,
  handlePatchGroup
};
