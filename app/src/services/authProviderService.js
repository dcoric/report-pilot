const appDb = require("../lib/appDb");

const PROVIDER_NAME_MAX = 64;
const PROVIDER_DISPLAY_NAME_MAX = 120;
const DEFAULT_SCOPES = ["openid", "email", "profile"];

function normalizeName(value) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > PROVIDER_NAME_MAX) return null;
  if (!/^[a-zA-Z0-9_-]+$/.test(trimmed)) return null;
  return trimmed;
}

function normalizeScopes(value) {
  if (value === undefined || value === null) return [...DEFAULT_SCOPES];
  if (!Array.isArray(value)) return null;
  const out = [];
  const seen = new Set();
  for (const entry of value) {
    if (typeof entry !== "string") return null;
    const trimmed = entry.trim();
    if (!trimmed) continue;
    if (!seen.has(trimmed)) {
      seen.add(trimmed);
      out.push(trimmed);
    }
  }
  if (!out.includes("openid")) out.unshift("openid");
  return out;
}

function normalizeClaimsMapping(value) {
  if (value === undefined || value === null) return {};
  if (typeof value !== "object" || Array.isArray(value)) return null;
  const out = {};
  if (typeof value.email === "string" && value.email.trim()) {
    out.email = value.email.trim();
  }
  if (typeof value.display_name === "string" && value.display_name.trim()) {
    out.display_name = value.display_name.trim();
  }
  return out;
}

function publicProvider(row, { includeSecret = false } = {}) {
  if (!row) return null;
  return {
    id: row.id,
    type: row.type,
    name: row.name,
    display_name: row.display_name,
    issuer: row.issuer,
    client_id: row.client_id,
    client_secret: includeSecret ? row.client_secret : (row.client_secret ? "***" : null),
    scopes: row.scopes,
    redirect_uri: row.redirect_uri,
    claims_mapping: row.claims_mapping,
    enabled: row.enabled,
    created_at: row.created_at,
    updated_at: row.updated_at
  };
}

async function listProviders() {
  const result = await appDb.query(
    `SELECT id, type, name, display_name, issuer, client_id, client_secret,
            scopes, redirect_uri, claims_mapping, enabled, created_at, updated_at
       FROM auth_providers
       ORDER BY lower(name)`
  );
  return result.rows.map((row) => publicProvider(row));
}

async function listEnabledProvidersForLogin() {
  const result = await appDb.query(
    `SELECT id, name, display_name, type
       FROM auth_providers
       WHERE enabled = TRUE
       ORDER BY lower(name)`
  );
  return result.rows.map((row) => ({
    id: row.id,
    name: row.name,
    display_name: row.display_name || row.name,
    type: row.type
  }));
}

async function findProviderById(id, { withSecret = false } = {}) {
  if (typeof id !== "string" || !id) return null;
  const result = await appDb.query(
    `SELECT id, type, name, display_name, issuer, client_id, client_secret,
            scopes, redirect_uri, claims_mapping, enabled, created_at, updated_at
       FROM auth_providers
       WHERE id = $1`,
    [id]
  );
  if (result.rowCount === 0) return null;
  return withSecret ? result.rows[0] : publicProvider(result.rows[0]);
}

async function findProviderRawByName(name) {
  const normalized = normalizeName(name);
  if (!normalized) return null;
  const result = await appDb.query(
    `SELECT id, type, name, display_name, issuer, client_id, client_secret,
            scopes, redirect_uri, claims_mapping, enabled, created_at, updated_at
       FROM auth_providers
       WHERE lower(name) = lower($1)`,
    [normalized]
  );
  return result.rowCount > 0 ? result.rows[0] : null;
}

function validatePayload(body) {
  const type = body && typeof body.type === "string" ? body.type : "oidc";
  if (type !== "oidc") {
    return { ok: false, message: "type must be 'oidc'" };
  }

  const name = normalizeName(body && body.name);
  if (!name) {
    return { ok: false, message: "name is required, alphanumeric with _ or -, up to 64 characters" };
  }

  const displayName = body && typeof body.display_name === "string" && body.display_name.trim()
    ? body.display_name.trim()
    : null;
  if (displayName && displayName.length > PROVIDER_DISPLAY_NAME_MAX) {
    return { ok: false, message: `display_name cannot exceed ${PROVIDER_DISPLAY_NAME_MAX} characters` };
  }

  const issuer = body && typeof body.issuer === "string" ? body.issuer.trim() : "";
  if (!issuer || !/^https?:\/\//i.test(issuer)) {
    return { ok: false, message: "issuer must be an http(s) URL" };
  }
  const clientId = body && typeof body.client_id === "string" ? body.client_id.trim() : "";
  if (!clientId) {
    return { ok: false, message: "client_id is required" };
  }
  const clientSecret = body && typeof body.client_secret === "string" ? body.client_secret : null;
  // Public clients (PKCE-only) may omit the secret; allow nullable.

  const redirectUri = body && typeof body.redirect_uri === "string" ? body.redirect_uri.trim() : "";
  if (!redirectUri || !/^https?:\/\//i.test(redirectUri)) {
    return { ok: false, message: "redirect_uri must be an http(s) URL" };
  }

  const scopes = normalizeScopes(body && body.scopes);
  if (scopes === null) {
    return { ok: false, message: "scopes must be an array of strings" };
  }

  const claimsMapping = normalizeClaimsMapping(body && body.claims_mapping);
  if (claimsMapping === null) {
    return { ok: false, message: "claims_mapping must be an object" };
  }

  const enabled = body && Object.prototype.hasOwnProperty.call(body, "enabled")
    ? Boolean(body.enabled)
    : true;

  return {
    ok: true,
    value: {
      type,
      name,
      display_name: displayName,
      issuer,
      client_id: clientId,
      client_secret: typeof clientSecret === "string" && clientSecret.length > 0 ? clientSecret : null,
      redirect_uri: redirectUri,
      scopes,
      claims_mapping: claimsMapping,
      enabled
    }
  };
}

async function upsertProvider(body) {
  const parsed = validatePayload(body);
  if (!parsed.ok) {
    return { statusCode: 400, body: { error: "bad_request", message: parsed.message } };
  }
  const v = parsed.value;
  const id = body && typeof body.id === "string" && body.id.trim() ? body.id.trim() : null;

  try {
    if (id) {
      const result = await appDb.query(
        `UPDATE auth_providers
            SET type = $2,
                name = $3,
                display_name = $4,
                issuer = $5,
                client_id = $6,
                client_secret = COALESCE($7, client_secret),
                scopes = $8,
                redirect_uri = $9,
                claims_mapping = $10::jsonb,
                enabled = $11,
                updated_at = NOW()
          WHERE id = $1
          RETURNING id, type, name, display_name, issuer, client_id, client_secret,
                    scopes, redirect_uri, claims_mapping, enabled, created_at, updated_at`,
        [
          id, v.type, v.name, v.display_name, v.issuer, v.client_id,
          v.client_secret, v.scopes, v.redirect_uri,
          JSON.stringify(v.claims_mapping), v.enabled
        ]
      );
      if (result.rowCount === 0) {
        return { statusCode: 404, body: { error: "not_found", message: "auth provider not found" } };
      }
      return { statusCode: 200, body: publicProvider(result.rows[0]) };
    }

    const result = await appDb.query(
      `INSERT INTO auth_providers
         (type, name, display_name, issuer, client_id, client_secret,
          scopes, redirect_uri, claims_mapping, enabled)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10)
       RETURNING id, type, name, display_name, issuer, client_id, client_secret,
                 scopes, redirect_uri, claims_mapping, enabled, created_at, updated_at`,
      [
        v.type, v.name, v.display_name, v.issuer, v.client_id, v.client_secret,
        v.scopes, v.redirect_uri, JSON.stringify(v.claims_mapping), v.enabled
      ]
    );
    return { statusCode: 201, body: publicProvider(result.rows[0]) };
  } catch (err) {
    if (err && err.code === "23505") {
      return { statusCode: 409, body: { error: "conflict", message: "a provider with that name already exists" } };
    }
    throw err;
  }
}

async function deleteProvider(id) {
  if (typeof id !== "string" || !id) {
    return { statusCode: 400, body: { error: "bad_request", message: "id is required" } };
  }
  const result = await appDb.query("DELETE FROM auth_providers WHERE id = $1 RETURNING id", [id]);
  if (result.rowCount === 0) {
    return { statusCode: 404, body: { error: "not_found", message: "auth provider not found" } };
  }
  return { statusCode: 200, body: { ok: true, id: result.rows[0].id } };
}

module.exports = {
  DEFAULT_SCOPES,
  publicProvider,
  listProviders,
  listEnabledProvidersForLogin,
  findProviderById,
  findProviderRawByName,
  upsertProvider,
  deleteProvider,
  validatePayload
};
