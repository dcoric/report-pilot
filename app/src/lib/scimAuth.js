// AUTH-013: bearer-token auth for /scim/v2/* routes. Distinct from the
// session-cookie path used everywhere else — SCIM clients are services,
// not browsers, and present an `Authorization: Bearer <token>` header.
//
// Returns `null` (and writes a SCIM-shaped error response) when the
// request is unauthenticated; otherwise returns the matched token record
// so the route can attribute SCIM activity to the bound provider.

const scimTokenService = require("../services/scimTokenService");

function buildScimErrorBody(status, detail) {
  return {
    schemas: ["urn:ietf:params:scim:api:messages:2.0:Error"],
    status: String(status),
    detail
  };
}

function writeScimError(res, status, detail) {
  res.writeHead(status, { "Content-Type": "application/scim+json" });
  res.end(JSON.stringify(buildScimErrorBody(status, detail)));
}

function parseBearer(req) {
  const header = req.headers && req.headers.authorization;
  if (typeof header !== "string") return null;
  const match = header.match(/^\s*Bearer\s+([A-Za-z0-9_\-.~+=/]+)\s*$/);
  return match ? match[1] : null;
}

async function authenticateScim(req, res) {
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

module.exports = {
  authenticateScim,
  parseBearer,
  writeScimError
};
