const appDb = require("../lib/appDb");
const auditService = require("./auditService");

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

// Columns selected from auth_providers everywhere the full provider record is
// needed. Kept in one place so adding a column (AUTH-012 did this with the
// JIT rules) only needs one edit.
const PROVIDER_COLUMNS = `
  id, type, name, display_name, issuer, client_id, client_secret,
  scopes, redirect_uri, claims_mapping, enabled,
  auto_link_by_email, jit_enabled, jit_default_role, jit_allowed_domains,
  require_email_verified,
  scim_group_mappings,
  created_at, updated_at
`;

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
    auto_link_by_email: row.auto_link_by_email !== false,
    jit_enabled: row.jit_enabled === true,
    jit_default_role: row.jit_default_role || "viewer",
    jit_allowed_domains: row.jit_allowed_domains || [],
    require_email_verified: row.require_email_verified !== false,
    scim_group_mappings: row.scim_group_mappings || {},
    created_at: row.created_at,
    updated_at: row.updated_at
  };
}

async function listProviders() {
  const result = await appDb.query(
    `SELECT ${PROVIDER_COLUMNS}
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
    `SELECT ${PROVIDER_COLUMNS} FROM auth_providers WHERE id = $1`,
    [id]
  );
  if (result.rowCount === 0) return null;
  return withSecret ? result.rows[0] : publicProvider(result.rows[0]);
}

async function findProviderRawByName(name) {
  const normalized = normalizeName(name);
  if (!normalized) return null;
  const result = await appDb.query(
    `SELECT ${PROVIDER_COLUMNS} FROM auth_providers WHERE lower(name) = lower($1)`,
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

async function upsertProvider(body, { actorUserId = null } = {}) {
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
          RETURNING ${PROVIDER_COLUMNS}`,
        [
          id, v.type, v.name, v.display_name, v.issuer, v.client_id,
          v.client_secret, v.scopes, v.redirect_uri,
          JSON.stringify(v.claims_mapping), v.enabled
        ]
      );
      if (result.rowCount === 0) {
        return { statusCode: 404, body: { error: "not_found", message: "auth provider not found" } };
      }
      await auditService
        .writeEvent({
          actorUserId,
          action: "auth_provider.updated",
          outcome: "success",
          details: {
            provider_id: result.rows[0].id,
            name: result.rows[0].name,
            enabled: result.rows[0].enabled
          }
        })
        .catch(() => {});
      return { statusCode: 200, body: publicProvider(result.rows[0]) };
    }

    const result = await appDb.query(
      `INSERT INTO auth_providers
         (type, name, display_name, issuer, client_id, client_secret,
          scopes, redirect_uri, claims_mapping, enabled)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10)
       RETURNING ${PROVIDER_COLUMNS}`,
      [
        v.type, v.name, v.display_name, v.issuer, v.client_id, v.client_secret,
        v.scopes, v.redirect_uri, JSON.stringify(v.claims_mapping), v.enabled
      ]
    );
    await auditService
      .writeEvent({
        actorUserId,
        action: "auth_provider.created",
        outcome: "success",
        details: {
          provider_id: result.rows[0].id,
          name: result.rows[0].name,
          type: result.rows[0].type
        }
      })
      .catch(() => {});
    return { statusCode: 201, body: publicProvider(result.rows[0]) };
  } catch (err) {
    if (err && err.code === "23505") {
      return { statusCode: 409, body: { error: "conflict", message: "a provider with that name already exists" } };
    }
    throw err;
  }
}

async function deleteProvider(id, { actorUserId = null } = {}) {
  if (typeof id !== "string" || !id) {
    return { statusCode: 400, body: { error: "bad_request", message: "id is required" } };
  }
  const result = await appDb.query(
    "DELETE FROM auth_providers WHERE id = $1 RETURNING id, name",
    [id]
  );
  if (result.rowCount === 0) {
    return { statusCode: 404, body: { error: "not_found", message: "auth provider not found" } };
  }
  await auditService
    .writeEvent({
      actorUserId,
      action: "auth_provider.deleted",
      outcome: "success",
      details: { provider_id: result.rows[0].id, name: result.rows[0].name }
    })
    .catch(() => {});
  return { statusCode: 200, body: { ok: true, id: result.rows[0].id } };
}

// AUTH-012: helpers for the per-provider JIT / linking rules. The rules live
// on the auth_providers row itself (no separate table) since they're a small
// fixed set of policy knobs. validate / publish / persist are kept distinct
// so the admin route can return a clean 400 instead of a 500 on bad input.

const RESERVED_DOMAIN = /^[a-z0-9.-]+\.[a-z]{2,}$/i;

function validateMappingRules(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return { ok: false, message: "mapping rules body must be an object" };
  }
  const value = {};

  if (Object.prototype.hasOwnProperty.call(body, "auto_link_by_email")) {
    if (typeof body.auto_link_by_email !== "boolean") {
      return { ok: false, message: "auto_link_by_email must be a boolean" };
    }
    value.auto_link_by_email = body.auto_link_by_email;
  }

  if (Object.prototype.hasOwnProperty.call(body, "require_email_verified")) {
    if (typeof body.require_email_verified !== "boolean") {
      return { ok: false, message: "require_email_verified must be a boolean" };
    }
    value.require_email_verified = body.require_email_verified;
  }

  if (Object.prototype.hasOwnProperty.call(body, "jit_enabled")) {
    if (typeof body.jit_enabled !== "boolean") {
      return { ok: false, message: "jit_enabled must be a boolean" };
    }
    value.jit_enabled = body.jit_enabled;
  }

  if (Object.prototype.hasOwnProperty.call(body, "jit_default_role")) {
    if (typeof body.jit_default_role !== "string" || !body.jit_default_role.trim()) {
      return { ok: false, message: "jit_default_role must be a non-empty string" };
    }
    value.jit_default_role = body.jit_default_role.trim().toLowerCase();
  }

  if (Object.prototype.hasOwnProperty.call(body, "jit_allowed_domains")) {
    const raw = body.jit_allowed_domains;
    if (!Array.isArray(raw)) {
      return { ok: false, message: "jit_allowed_domains must be an array of strings" };
    }
    const out = [];
    const seen = new Set();
    for (const entry of raw) {
      if (typeof entry !== "string") {
        return { ok: false, message: "jit_allowed_domains entries must be strings" };
      }
      const trimmed = entry.trim().toLowerCase();
      if (!trimmed) continue;
      if (!RESERVED_DOMAIN.test(trimmed)) {
        return {
          ok: false,
          message: `jit_allowed_domains entry '${entry}' is not a valid domain`
        };
      }
      if (!seen.has(trimmed)) {
        seen.add(trimmed);
        out.push(trimmed);
      }
    }
    value.jit_allowed_domains = out;
  }

  if (Object.keys(value).length === 0) {
    return { ok: false, message: "at least one rule field must be provided" };
  }
  return { ok: true, value };
}

async function updateMappingRules(providerId, body, { actorUserId = null } = {}) {
  if (typeof providerId !== "string" || !providerId) {
    return { statusCode: 400, body: { error: "bad_request", message: "provider id is required" } };
  }
  const parsed = validateMappingRules(body);
  if (!parsed.ok) {
    return { statusCode: 400, body: { error: "bad_request", message: parsed.message } };
  }
  const updates = [];
  const params = [providerId];
  for (const [field, val] of Object.entries(parsed.value)) {
    params.push(val);
    updates.push(`${field} = $${params.length}`);
  }
  const result = await appDb.query(
    `UPDATE auth_providers
        SET ${updates.join(", ")}, updated_at = NOW()
      WHERE id = $1
      RETURNING ${PROVIDER_COLUMNS}`,
    params
  );
  if (result.rowCount === 0) {
    return { statusCode: 404, body: { error: "not_found", message: "auth provider not found" } };
  }
  await auditService
    .writeEvent({
      actorUserId,
      action: "auth_provider.mapping_rules.updated",
      outcome: "success",
      details: {
        provider_id: result.rows[0].id,
        name: result.rows[0].name,
        ...parsed.value
      }
    })
    .catch(() => {});
  const row = result.rows[0];
  return {
    statusCode: 200,
    body: {
      provider_id: row.id,
      auto_link_by_email: row.auto_link_by_email,
      jit_enabled: row.jit_enabled,
      jit_default_role: row.jit_default_role,
      jit_allowed_domains: row.jit_allowed_domains || [],
      require_email_verified: row.require_email_verified !== false
    }
  };
}

// AUTH-013: SCIM group → local-role mapping. Stored as a JSONB column on
// the provider row; we treat the keys (SCIM group displayNames) as
// case-insensitive at lookup time but preserve their original casing for
// display purposes when admins view the rules.
function validateScimGroupMappings(body) {
  if (body == null || typeof body !== "object" || Array.isArray(body)) {
    return { ok: false, message: "group_mappings must be an object" };
  }
  const out = {};
  for (const [groupName, roleName] of Object.entries(body)) {
    if (typeof groupName !== "string") {
      return { ok: false, message: "group_mappings keys must be strings" };
    }
    const trimmedGroup = groupName.trim();
    if (!trimmedGroup) {
      return { ok: false, message: "group_mappings keys must be non-empty" };
    }
    if (typeof roleName !== "string") {
      return { ok: false, message: `group_mappings['${groupName}'] must be a role name string` };
    }
    const trimmedRole = roleName.trim().toLowerCase();
    if (!trimmedRole) {
      return { ok: false, message: `group_mappings['${groupName}'] must be a non-empty role name` };
    }
    out[trimmedGroup] = trimmedRole;
  }
  return { ok: true, value: out };
}

async function updateScimGroupMappings(providerId, body, { actorUserId = null } = {}) {
  if (typeof providerId !== "string" || !providerId) {
    return { statusCode: 400, body: { error: "bad_request", message: "provider id is required" } };
  }
  const parsed = validateScimGroupMappings(body);
  if (!parsed.ok) {
    return { statusCode: 400, body: { error: "bad_request", message: parsed.message } };
  }
  const result = await appDb.query(
    `UPDATE auth_providers
        SET scim_group_mappings = $2::jsonb, updated_at = NOW()
      WHERE id = $1
      RETURNING ${PROVIDER_COLUMNS}`,
    [providerId, JSON.stringify(parsed.value)]
  );
  if (result.rowCount === 0) {
    return { statusCode: 404, body: { error: "not_found", message: "auth provider not found" } };
  }
  await auditService
    .writeEvent({
      actorUserId,
      action: "auth_provider.scim_group_mappings.updated",
      outcome: "success",
      details: {
        provider_id: result.rows[0].id,
        name: result.rows[0].name,
        mappings: parsed.value
      }
    })
    .catch(() => {});
  return {
    statusCode: 200,
    body: {
      provider_id: result.rows[0].id,
      group_mappings: result.rows[0].scim_group_mappings || {}
    }
  };
}

// Resolve a list of SCIM group display names to a sorted, deduplicated set
// of local role names, using the provider's case-insensitive mapping.
function scimGroupsToRoles(provider, groupDisplayNames) {
  if (!provider || !Array.isArray(groupDisplayNames)) return [];
  const mappings = provider.scim_group_mappings || {};
  const lookup = new Map();
  for (const [key, value] of Object.entries(mappings)) {
    lookup.set(String(key).toLowerCase(), value);
  }
  const out = new Set();
  for (const name of groupDisplayNames) {
    if (typeof name !== "string") continue;
    const match = lookup.get(name.trim().toLowerCase());
    if (match) out.add(match);
  }
  return [...out].sort();
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
  validatePayload,
  validateMappingRules,
  updateMappingRules,
  validateScimGroupMappings,
  updateScimGroupMappings,
  scimGroupsToRoles
};
