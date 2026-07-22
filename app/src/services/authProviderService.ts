import appDb = require("../lib/appDb");
import auditService = require("./auditService");

const PROVIDER_NAME_MAX = 64;
const PROVIDER_DISPLAY_NAME_MAX = 120;
export const DEFAULT_SCOPES: ReadonlyArray<string> = ["openid", "email", "profile"];

export interface ProviderRow {
  id: string;
  type: string;
  name: string;
  display_name: string | null;
  issuer: string;
  client_id: string;
  client_secret: string | null;
  scopes: string[];
  redirect_uri: string;
  claims_mapping: Record<string, unknown> | null;
  enabled: boolean;
  auto_link_by_email?: boolean;
  jit_enabled?: boolean;
  jit_default_role?: string | null;
  jit_allowed_domains?: string[] | null;
  require_email_verified?: boolean;
  scim_group_mappings?: Record<string, string> | null;
  created_at: Date | string;
  updated_at: Date | string;
}

export interface PublicProvider {
  id: string;
  type: string;
  name: string;
  display_name: string | null;
  issuer: string;
  client_id: string;
  client_secret: string | null;
  scopes: string[];
  redirect_uri: string;
  claims_mapping: Record<string, unknown> | null;
  enabled: boolean;
  auto_link_by_email: boolean;
  jit_enabled: boolean;
  jit_default_role: string;
  jit_allowed_domains: string[];
  require_email_verified: boolean;
  scim_group_mappings: Record<string, string>;
  created_at: Date | string;
  updated_at: Date | string;
}

export interface ServiceResponse<T = unknown> {
  statusCode: number;
  body: T;
}

interface ClaimsMapping {
  email?: string;
  display_name?: string;
}

type ValidatePayloadResult =
  | { ok: true; value: {
      type: string;
      name: string;
      display_name: string | null;
      issuer: string;
      client_id: string;
      client_secret: string | null;
      redirect_uri: string;
      scopes: string[];
      claims_mapping: ClaimsMapping;
      enabled: boolean;
    } }
  | { ok: false; message: string };

type ValidateRulesResult =
  | { ok: true; value: {
      auto_link_by_email?: boolean;
      require_email_verified?: boolean;
      jit_enabled?: boolean;
      jit_default_role?: string;
      jit_allowed_domains?: string[];
    } }
  | { ok: false; message: string };

type ValidateGroupMappingsResult =
  | { ok: true; value: Record<string, string> }
  | { ok: false; message: string };

function normalizeName(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > PROVIDER_NAME_MAX) return null;
  if (!/^[a-zA-Z0-9_-]+$/.test(trimmed)) return null;
  return trimmed;
}

function normalizeScopes(value: unknown): string[] | null {
  if (value === undefined || value === null) return [...DEFAULT_SCOPES];
  if (!Array.isArray(value)) return null;
  const out: string[] = [];
  const seen = new Set<string>();
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

function normalizeClaimsMapping(value: unknown): ClaimsMapping | null {
  if (value === undefined || value === null) return {};
  if (typeof value !== "object" || Array.isArray(value)) return null;
  const v = value as Record<string, unknown>;
  const out: ClaimsMapping = {};
  if (typeof v.email === "string" && v.email.trim()) {
    out.email = v.email.trim();
  }
  if (typeof v.display_name === "string" && v.display_name.trim()) {
    out.display_name = v.display_name.trim();
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
  scim_group_mappings, provider_config,
  created_at, updated_at
`;

export function publicProvider(row: ProviderRow | null | undefined, { includeSecret = false }: { includeSecret?: boolean } = {}): PublicProvider | null {
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

export async function listProviders(): Promise<Array<PublicProvider | null>> {
  const result = await appDb.query<ProviderRow>(
    `SELECT ${PROVIDER_COLUMNS}
       FROM auth_providers
       ORDER BY lower(name)`
  );
  return result.rows.map((row) => publicProvider(row));
}

export async function listEnabledProvidersForLogin(): Promise<Array<{ id: string; name: string; display_name: string; type: string }>> {
  const result = await appDb.query<{ id: string; name: string; display_name: string | null; type: string }>(
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

export async function findProviderById(id: unknown, { withSecret = false }: { withSecret?: boolean } = {}): Promise<ProviderRow | PublicProvider | null> {
  if (typeof id !== "string" || !id) return null;
  const result = await appDb.query<ProviderRow>(
    `SELECT ${PROVIDER_COLUMNS} FROM auth_providers WHERE id = $1`,
    [id]
  );
  if (result.rowCount === 0) return null;
  return withSecret ? result.rows[0] : publicProvider(result.rows[0]);
}

export async function findProviderRawByName(name: unknown): Promise<ProviderRow | null> {
  const normalized = normalizeName(name);
  if (!normalized) return null;
  const result = await appDb.query<ProviderRow>(
    `SELECT ${PROVIDER_COLUMNS} FROM auth_providers WHERE lower(name) = lower($1)`,
    [normalized]
  );
  return (result.rowCount ?? 0) > 0 ? result.rows[0] : null;
}

export function validatePayload(body: unknown): ValidatePayloadResult {
  const b = (body && typeof body === "object" ? body : {}) as Record<string, unknown>;
  const type = typeof b.type === "string" ? b.type : "oidc";
  
  // Support all provider types
  const supportedTypes = ['oidc', 'saml', 'ldap', 'ad', 'pd'];
  if (!supportedTypes.includes(type)) {
    return { ok: false, message: `type must be one of: ${supportedTypes.join(', ')}` };
  }

  const name = normalizeName(b.name);
  if (!name) {
    return { ok: false, message: "name is required" };
  }

  const displayName = typeof b.display_name === "string" ? b.display_name.trim() : "";
  if (displayName.length > PROVIDER_DISPLAY_NAME_MAX) {
    return { ok: false, message: `display_name cannot exceed ${PROVIDER_DISPLAY_NAME_MAX} characters` };
  }

  // Validation by provider type
  if (type === "oidc") {
    const issuer = typeof b.issuer === "string" ? b.issuer.trim() : "";
    if (!issuer || !/^https?:\/\//i.test(issuer)) {
      return { ok: false, message: "issuer must be an http(s) URL" };
    }
    
    const clientId = typeof b.client_id === "string" ? b.client_id.trim() : "";
    if (!clientId) {
      return { ok: false, message: "client_id is required" };
    }
    
    const redirectUri = typeof b.redirect_uri === "string" ? b.redirect_uri.trim() : "";
    if (!redirectUri || !/^https?:\/\//i.test(redirectUri)) {
      return { ok: false, message: "redirect_uri must be an http(s) URL" };
    }

    const scopes = normalizeScopes(b.scopes);
    if (scopes === null) {
      return { ok: false, message: "scopes must be an array of strings" };
    }

    const claimsMapping = normalizeClaimsMapping(b.claims_mapping);
    if (claimsMapping === null) {
      return { ok: false, message: "claims_mapping must be an object" };
    }

    const clientSecret = typeof b.client_secret === "string" ? b.client_secret : null;
    // Public clients (PKCE-only) may omit the secret; allow nullable.

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
        enabled: Object.prototype.hasOwnProperty.call(b, "enabled") ? Boolean(b.enabled) : true
      }
    };
  } else if (type === "saml") {
    // SAML specific validations
    const issuer = typeof b.issuer === "string" ? b.issuer.trim() : "";
    if (!issuer || !/^https?:\/\//i.test(issuer)) {
      return { ok: false, message: "issuer must be an http(s) URL" };
    }
    
    const redirectUri = typeof b.redirect_uri === "string" ? b.redirect_uri.trim() : "";
    if (!redirectUri || !/^https?:\/\//i.test(redirectUri)) {
      return { ok: false, message: "redirect_uri must be an http(s) URL" };
    }
    
    // SAML doesn't require client_id or client_secret but we validate what's provided
    
    return {
      ok: true,
      value: {
        type,
        name,
        display_name: displayName,
        issuer,
        client_id: typeof b.client_id === "string" && b.client_id.trim() ? b.client_id.trim() : "report-pilot-sp",
        client_secret: null,
        redirect_uri: redirectUri,
        scopes: [],
        claims_mapping: {},
        enabled: Object.prototype.hasOwnProperty.call(b, "enabled") ? Boolean(b.enabled) : true
      }
    };
  } else {
    // For LDAP, AD, and PD, validate only basic fields - they may not require specific fields
    return {
      ok: true,
      value: {
        type,
        name,
        display_name: displayName,
        issuer: "",
        client_id: "",
        client_secret: null,
        redirect_uri: "",
        scopes: [],
        claims_mapping: {},
        enabled: Object.prototype.hasOwnProperty.call(b, "enabled") ? Boolean(b.enabled) : true
      }
    };
  }
}

export async function upsertProvider(body: unknown, { actorUserId = null }: { actorUserId?: string | null } = {}): Promise<ServiceResponse> {
  const parsed = validatePayload(body);
  if (parsed.ok !== true) {
    return { statusCode: 400, body: { error: "bad_request", message: parsed.message } };
  }
  const v = parsed.value;
  const b = (body && typeof body === "object" ? body : {}) as Record<string, unknown>;
  const id = typeof b.id === "string" && b.id.trim() ? b.id.trim() : null;

  try {
    if (id) {
      const result = await appDb.query<ProviderRow>(
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
                provider_config = $12::jsonb,
                updated_at = NOW()
          WHERE id = $1
          RETURNING ${PROVIDER_COLUMNS}`,
        [
          id, v.type, v.name, v.display_name, v.issuer, v.client_id,
          v.client_secret, v.scopes, v.redirect_uri,
          JSON.stringify(v.claims_mapping), v.enabled, JSON.stringify({})
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

    const result = await appDb.query<ProviderRow>(
      `INSERT INTO auth_providers
         (type, name, display_name, issuer, client_id, client_secret,
          scopes, redirect_uri, claims_mapping, enabled, provider_config)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10, $11::jsonb)
       RETURNING ${PROVIDER_COLUMNS}`,
      [
        v.type, v.name, v.display_name, v.issuer, v.client_id, v.client_secret,
        v.scopes, v.redirect_uri, JSON.stringify(v.claims_mapping), v.enabled, JSON.stringify({})
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
    if (err && (err as { code?: string }).code === "23505") {
      return { statusCode: 409, body: { error: "conflict", message: "a provider with that name already exists" } };
    }
    throw err;
  }
}

export async function deleteProvider(id: unknown, { actorUserId = null }: { actorUserId?: string | null } = {}): Promise<ServiceResponse> {
  if (typeof id !== "string" || !id) {
    return { statusCode: 400, body: { error: "bad_request", message: "id is required" } };
  }
  const result = await appDb.query<{ id: string; name: string }>(
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

interface MappingRulesUpdate {
  auto_link_by_email?: boolean;
  require_email_verified?: boolean;
  jit_enabled?: boolean;
  jit_default_role?: string;
  jit_allowed_domains?: string[];
}

export function validateMappingRules(body: unknown): ValidateRulesResult {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return { ok: false, message: "mapping rules body must be an object" };
  }
  const b = body as Record<string, unknown>;
  const value: MappingRulesUpdate = {};

  if (Object.prototype.hasOwnProperty.call(b, "auto_link_by_email")) {
    if (typeof b.auto_link_by_email !== "boolean") {
      return { ok: false, message: "auto_link_by_email must be a boolean" };
    }
    value.auto_link_by_email = b.auto_link_by_email;
  }

  if (Object.prototype.hasOwnProperty.call(b, "require_email_verified")) {
    if (typeof b.require_email_verified !== "boolean") {
      return { ok: false, message: "require_email_verified must be a boolean" };
    }
    value.require_email_verified = b.require_email_verified;
  }

  if (Object.prototype.hasOwnProperty.call(b, "jit_enabled")) {
    if (typeof b.jit_enabled !== "boolean") {
      return { ok: false, message: "jit_enabled must be a boolean" };
    }
    value.jit_enabled = b.jit_enabled;
  }

  if (Object.prototype.hasOwnProperty.call(b, "jit_default_role")) {
    if (typeof b.jit_default_role !== "string" || !b.jit_default_role.trim()) {
      return { ok: false, message: "jit_default_role must be a non-empty string" };
    }
    value.jit_default_role = b.jit_default_role.trim().toLowerCase();
  }

  if (Object.prototype.hasOwnProperty.call(b, "jit_allowed_domains")) {
    const raw = b.jit_allowed_domains;
    if (!Array.isArray(raw)) {
      return { ok: false, message: "jit_allowed_domains must be an array of strings" };
    }
    const out: string[] = [];
    const seen = new Set<string>();
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

export async function updateMappingRules(providerId: unknown, body: unknown, { actorUserId = null }: { actorUserId?: string | null } = {}): Promise<ServiceResponse> {
  if (typeof providerId !== "string" || !providerId) {
    return { statusCode: 400, body: { error: "bad_request", message: "provider id is required" } };
  }
  const parsed = validateMappingRules(body);
  if (parsed.ok !== true) {
    return { statusCode: 400, body: { error: "bad_request", message: parsed.message } };
  }
  const updates: string[] = [];
  const params: unknown[] = [providerId];
  for (const [field, val] of Object.entries(parsed.value)) {
    params.push(val);
    updates.push(`${field} = $${params.length}`);
  }
  const result = await appDb.query<ProviderRow>(
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
export function validateScimGroupMappings(body: unknown): ValidateGroupMappingsResult {
  if (body == null || typeof body !== "object" || Array.isArray(body)) {
    return { ok: false, message: "group_mappings must be an object" };
  }
  const out: Record<string, string> = {};
  for (const [groupName, roleName] of Object.entries(body as Record<string, unknown>)) {
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

export async function updateScimGroupMappings(providerId: unknown, body: unknown, { actorUserId = null }: { actorUserId?: string | null } = {}): Promise<ServiceResponse> {
  if (typeof providerId !== "string" || !providerId) {
    return { statusCode: 400, body: { error: "bad_request", message: "provider id is required" } };
  }
  const parsed = validateScimGroupMappings(body);
  if (parsed.ok !== true) {
    return { statusCode: 400, body: { error: "bad_request", message: parsed.message } };
  }
  const result = await appDb.query<ProviderRow>(
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
export function scimGroupsToRoles(provider: unknown, groupDisplayNames: unknown[]): string[] {
  if (!provider || typeof provider !== "object" || !Array.isArray(groupDisplayNames)) return [];
  const mappings = (provider as { scim_group_mappings?: Record<string, string> }).scim_group_mappings || {};
  const lookup = new Map<string, string>();
  for (const [key, value] of Object.entries(mappings)) {
    lookup.set(String(key).toLowerCase(), value);
  }
  const out = new Set<string>();
  for (const name of groupDisplayNames) {
    if (typeof name !== "string") continue;
    const match = lookup.get(name.trim().toLowerCase());
    if (match) out.add(match);
  }
  return [...out].sort();
}
