// AUTH-013: SCIM 2.0 user provisioning. The IdP POSTs / PATCHes / PUTs
// SCIM Core User resources, and this service translates them into local
// users + linked_identities + role assignments.
//
// Design notes:
//
//   * `userName` and the primary email map to our `users.email`. SCIM
//     spec is loose about which of the two is "the" identifier; we treat
//     them interchangeably and prefer the primary email when both are
//     present and differ.
//
//   * `externalId` (or the resource id from the IdP) becomes the
//     `linked_identities.subject` so a subsequent SSO login arrives via
//     the AUTH-012 `linked_by_sub` fast path with no further bookkeeping.
//
//   * `active=false` from the IdP toggles `users.is_active` rather than
//     deleting the row, matching SCIM's deactivate-not-delete convention.
//     A DELETE on the SCIM resource is treated the same way.
//
//   * Group membership is supplied via SCIM Groups (handled separately)
//     but the per-user role hint can also arrive on the user resource;
//     we just store no roles here unless the SCIM Group flow assigns
//     them. Reflects the spec recommendation.

import type { PoolClient } from "pg";
import appDb = require("../lib/appDb");
import authService = require("./authService");
import auditService = require("./auditService");
import linkedIdentityService = require("./linkedIdentityService");
import roleService = require("./roleService");

export const SCIM_USER_SCHEMA = "urn:ietf:params:scim:schemas:core:2.0:User";
export const SCIM_LIST_RESPONSE_SCHEMA = "urn:ietf:params:scim:api:messages:2.0:ListResponse";
export const SCIM_ERROR_SCHEMA = "urn:ietf:params:scim:api:messages:2.0:Error";

interface ScimEmail {
  value?: string;
  primary?: boolean;
  type?: string;
}

interface ScimName {
  formatted?: string;
  givenName?: string;
  familyName?: string;
}

export interface ScimUserBody {
  id?: string;
  externalId?: string;
  userName?: string;
  displayName?: string;
  active?: boolean;
  emails?: ScimEmail[];
  name?: ScimName;
}

interface ScimOperation {
  op?: string;
  path?: string;
  value?: unknown;
}

export interface ScimPatchBody {
  Operations?: ScimOperation[];
}

interface UserRow {
  id: string;
  email: string;
  password_hash?: string | null;
  display_name: string | null;
  is_active: boolean;
  last_login_at?: Date | string | null;
  created_at: Date | string;
  updated_at: Date | string;
}

export interface ServiceResponse<T = unknown> {
  statusCode: number;
  body: T;
}

export interface ScimContextArgs {
  providerId: string;
  body?: ScimUserBody;
  actorUserId?: string | null;
  ipAddress?: string | null;
  userAgent?: string | null;
}

function pickPrimaryEmail(emails: ScimEmail[] | undefined): string | null {
  if (!Array.isArray(emails)) return null;
  const primary = emails.find((e) => e && e.primary && typeof e.value === "string" && e.value.trim());
  if (primary) return primary.value!.trim();
  const first = emails.find((e) => e && typeof e.value === "string" && e.value.trim());
  return first ? first.value!.trim() : null;
}

function resourceEmail(body: ScimUserBody | undefined): string | null {
  // Prefer the primary entry in `emails`; fall back to `userName` (most IdPs
  // set both to the same value).
  return pickPrimaryEmail(body?.emails) || (body && typeof body.userName === "string" ? body.userName : null);
}

function resourceDisplayName(body: ScimUserBody | undefined): string | null {
  if (!body) return null;
  if (typeof body.displayName === "string" && body.displayName.trim()) return body.displayName.trim();
  if (body.name && typeof body.name.formatted === "string" && body.name.formatted.trim()) {
    return body.name.formatted.trim();
  }
  if (body.name && (body.name.givenName || body.name.familyName)) {
    return [body.name.givenName, body.name.familyName].filter(Boolean).join(" ").trim() || null;
  }
  return null;
}

function resourceActive(body: ScimUserBody | undefined, defaultActive = true): boolean {
  if (body && Object.prototype.hasOwnProperty.call(body, "active")) {
    return Boolean(body.active);
  }
  return defaultActive;
}

function resourceExternalId(body: ScimUserBody | undefined): string | null {
  if (body && typeof body.externalId === "string" && body.externalId.trim()) {
    return body.externalId.trim();
  }
  if (body && typeof body.id === "string" && body.id.trim()) {
    return body.id.trim();
  }
  return null;
}

export function scimError(status: number, detail: string, scimType: string | null = null): ServiceResponse {
  const body: Record<string, unknown> = {
    schemas: [SCIM_ERROR_SCHEMA],
    status: String(status),
    detail
  };
  if (scimType) body.scimType = scimType;
  return { statusCode: status, body };
}

export function userToScim(user: UserRow, externalId: string | null = null): Record<string, unknown> {
  return {
    schemas: [SCIM_USER_SCHEMA],
    id: user.id,
    userName: user.email,
    externalId: externalId || null,
    name: user.display_name ? { formatted: user.display_name } : undefined,
    displayName: user.display_name || undefined,
    active: user.is_active !== false,
    emails: [{ value: user.email, primary: true, type: "work" }],
    meta: {
      resourceType: "User",
      created: user.created_at,
      lastModified: user.updated_at,
      location: `/scim/v2/Users/${user.id}`
    }
  };
}

async function loadUser(userId: string, client: PoolClient | null = null): Promise<UserRow | null> {
  const exec = (client || appDb) as typeof appDb;
  const result = await exec.query<UserRow>(
    `SELECT id, email, password_hash, display_name, is_active, last_login_at, created_at, updated_at
       FROM users WHERE id = $1`,
    [userId]
  );
  return result.rows[0] || null;
}

export async function findUserByExternalId(providerId: string, externalId: string, client: PoolClient | null = null): Promise<UserRow | null> {
  if (!providerId || !externalId) return null;
  const exec = (client || appDb) as typeof appDb;
  const result = await exec.query<UserRow>(
    `SELECT u.id, u.email, u.password_hash, u.display_name, u.is_active, u.last_login_at, u.created_at, u.updated_at
       FROM linked_identities li
       JOIN users u ON u.id = li.user_id
      WHERE li.provider_id = $1 AND li.subject = $2`,
    [providerId, externalId]
  );
  return result.rows[0] || null;
}

export async function listUsers({ providerId, filter, startIndex = 1, count = 100 }: {
  providerId: string;
  filter?: string;
  startIndex?: number;
  count?: number;
}): Promise<Record<string, unknown>> {
  const limit = Math.max(1, Math.min(Number(count) || 100, 200));
  const offset = Math.max(0, (Number(startIndex) || 1) - 1);
  const params: unknown[] = [providerId];
  let where = "li.provider_id = $1";
  if (filter && typeof filter === "string") {
    // Minimal filter support: `userName eq "x"` or `externalId eq "x"`.
    // Sufficient for the dedup checks every major IdP performs on POST.
    const eq = filter.match(/^(userName|externalId|emails(?:\.value)?)\s+eq\s+"([^"]+)"\s*$/i);
    if (eq) {
      const field = eq[1].toLowerCase();
      const value = eq[2];
      params.push(value);
      if (field === "externalid") {
        where += ` AND li.subject = $${params.length}`;
      } else {
        where += ` AND lower(u.email) = lower($${params.length})`;
      }
    }
  }
  const totalResult = await appDb.query<{ total: number }>(
    `SELECT COUNT(*)::int AS total
       FROM linked_identities li
       JOIN users u ON u.id = li.user_id
      WHERE ${where}`,
    params
  );
  params.push(limit);
  params.push(offset);
  const listResult = await appDb.query<UserRow & { external_id: string }>(
    `SELECT u.id, u.email, u.display_name, u.is_active, u.created_at, u.updated_at,
            li.subject AS external_id
       FROM linked_identities li
       JOIN users u ON u.id = li.user_id
      WHERE ${where}
      ORDER BY lower(u.email)
      LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params
  );
  return {
    schemas: [SCIM_LIST_RESPONSE_SCHEMA],
    totalResults: totalResult.rows[0].total,
    itemsPerPage: limit,
    startIndex: offset + 1,
    Resources: listResult.rows.map((row) => userToScim(row, row.external_id))
  };
}

export async function getUser({ providerId, userId }: { providerId: string; userId: string }): Promise<ServiceResponse> {
  const user = await loadUser(userId);
  if (!user) return scimError(404, "user not found");
  // Optional: enforce provider linkage so a SCIM token from IdP A can't
  // read users only linked to IdP B.
  const linkResult = await appDb.query<{ subject: string }>(
    `SELECT subject FROM linked_identities WHERE provider_id = $1 AND user_id = $2`,
    [providerId, userId]
  );
  if (linkResult.rowCount === 0) {
    return scimError(404, "user not found for this provider");
  }
  return { statusCode: 200, body: userToScim(user, linkResult.rows[0].subject) };
}

export async function createUser({ providerId, body, actorUserId = null, ipAddress = null, userAgent = null }: ScimContextArgs): Promise<ServiceResponse> {
  const email = resourceEmail(body);
  const externalId = resourceExternalId(body);
  if (!email) {
    return scimError(400, "userName / emails is required", "invalidValue");
  }
  if (!externalId) {
    return scimError(400, "externalId is required", "invalidValue");
  }
  const normalizedEmail = authService.normalizeEmail(email);
  if (!normalizedEmail) {
    return scimError(400, `'${email}' is not a valid email address`, "invalidValue");
  }
  const displayName = resourceDisplayName(body);
  const active = resourceActive(body, true);

  // If the external identity is already linked, treat as a conflict (SCIM
  // 409). The IdP should PUT/PATCH the existing resource instead.
  const existingByExternal = await findUserByExternalId(providerId, externalId);
  if (existingByExternal) {
    return scimError(409, "user already linked for this provider", "uniqueness");
  }

  try {
    const created = await appDb.withTransaction(async (client: PoolClient) => {
      // Re-use an existing local user if the email already exists; otherwise
      // create one. This matches the AUTH-012 auto-link policy spirit but is
      // unconditional for SCIM (the IdP has explicit administrative
      // authority over user lifecycle, so collisions resolve as "link").
      const existingByEmail = await client.query<UserRow>(
        `SELECT id, email, password_hash, display_name, is_active,
                last_login_at, created_at, updated_at
           FROM users WHERE lower(email) = $1`,
        [normalizedEmail]
      );
      let user: UserRow = existingByEmail.rows[0];
      if (!user) {
        const insertResult = await client.query<UserRow>(
          `INSERT INTO users (email, password_hash, display_name, is_active)
           VALUES ($1, NULL, $2, $3)
           RETURNING id, email, password_hash, display_name, is_active,
                     last_login_at, created_at, updated_at`,
          [normalizedEmail, displayName, active]
        );
        user = insertResult.rows[0];
        await roleService.writeAuditEntry(client, {
          actorUserId,
          targetUserId: user.id,
          action: "user.created",
          details: { email: user.email, source: "scim", provider_id: providerId }
        });
      } else if (active !== user.is_active || (displayName && displayName !== user.display_name)) {
        const next = await client.query<UserRow>(
          `UPDATE users SET is_active = $2, display_name = COALESCE($3, display_name), updated_at = NOW()
            WHERE id = $1
            RETURNING id, email, password_hash, display_name, is_active,
                      last_login_at, created_at, updated_at`,
          [user.id, active, displayName]
        );
        user = next.rows[0];
      }
      await client.query(
        `INSERT INTO linked_identities (user_id, provider_id, subject, email_at_link)
         VALUES ($1, $2, $3, $4)`,
        [user.id, providerId, externalId, user.email]
      );
      return user;
    });
    await auditService
      .writeEvent({
        actorUserId,
        actorEmail: created.email,
        targetUserId: created.id,
        action: "scim.user.created",
        outcome: "success",
        details: { provider_id: providerId, subject: externalId, active: created.is_active },
        ipAddress,
        userAgent
      })
      .catch(() => {});
    return { statusCode: 201, body: userToScim(created, externalId) };
  } catch (err) {
    if (err && (err as { code?: string }).code === "23505") {
      return scimError(409, "duplicate user", "uniqueness");
    }
    throw err;
  }
}

export async function replaceUser(
  { providerId, userId, body, actorUserId = null, ipAddress = null, userAgent = null }:
  ScimContextArgs & { userId: string }
): Promise<ServiceResponse> {
  const existing = await findUserByExternalIdOrUserId(providerId, userId);
  if (!existing) return scimError(404, "user not found for this provider");

  const email = resourceEmail(body) || existing.email;
  const normalizedEmail = authService.normalizeEmail(email);
  if (!normalizedEmail) return scimError(400, `'${email}' is not a valid email address`, "invalidValue");
  const displayName = resourceDisplayName(body);
  const active = resourceActive(body, existing.is_active);

  const result = await appDb.query<UserRow>(
    `UPDATE users
        SET email = $2,
            display_name = $3,
            is_active = $4,
            updated_at = NOW()
      WHERE id = $1
      RETURNING id, email, password_hash, display_name, is_active,
                last_login_at, created_at, updated_at`,
    [existing.id, normalizedEmail, displayName, active]
  );
  const updated = result.rows[0];
  await auditService
    .writeEvent({
      actorUserId,
      actorEmail: updated.email,
      targetUserId: updated.id,
      action: "scim.user.updated",
      outcome: "success",
      details: { provider_id: providerId, active: updated.is_active },
      ipAddress,
      userAgent
    })
    .catch(() => {});
  const link = await appDb.query<{ subject: string }>(
    `SELECT subject FROM linked_identities WHERE provider_id = $1 AND user_id = $2`,
    [providerId, updated.id]
  );
  return { statusCode: 200, body: userToScim(updated, link.rows[0] && link.rows[0].subject) };
}

// PATCH with the SCIM 2.0 PatchOp model. We support the minimum the major
// IdPs use in practice: replace operations on `active`, `userName`,
// `displayName`, and `emails`. Anything else is silently ignored.
export async function patchUser(
  { providerId, userId, body, actorUserId = null, ipAddress = null, userAgent = null }:
  Omit<ScimContextArgs, "body"> & { userId: string; body?: ScimPatchBody }
): Promise<ServiceResponse> {
  const existing = await findUserByExternalIdOrUserId(providerId, userId);
  if (!existing) return scimError(404, "user not found for this provider");
  if (!body || !Array.isArray(body.Operations)) {
    return scimError(400, "Operations array is required", "invalidSyntax");
  }
  // Snapshot the pre-patch state — the UPDATE below may share row identity
  // with `existing` depending on the pool's caching strategy, so reading
  // `existing.is_active` after the UPDATE would reflect the new value and
  // hide deactivations from the audit log.
  const wasActive = existing.is_active;
  let active = existing.is_active;
  let email = existing.email;
  let displayName = existing.display_name;
  for (const op of body.Operations) {
    if (!op || typeof op.op !== "string") continue;
    const opName = op.op.toLowerCase();
    if (opName !== "replace" && opName !== "add") continue; // remove unsupported in MVP
    const opVal = op.value as Record<string, unknown> | undefined;
    if (op.path === "active" || (opVal && Object.prototype.hasOwnProperty.call(opVal, "active"))) {
      const next = op.path === "active" ? op.value : opVal!.active;
      if (typeof next === "boolean") active = next;
    }
    if (op.path === "userName" || (opVal && Object.prototype.hasOwnProperty.call(opVal, "userName"))) {
      const next = op.path === "userName" ? op.value : opVal!.userName;
      if (typeof next === "string") email = next;
    }
    if (op.path === "displayName" || (opVal && Object.prototype.hasOwnProperty.call(opVal, "displayName"))) {
      const next = op.path === "displayName" ? op.value : opVal!.displayName;
      if (typeof next === "string") displayName = next.trim() || null;
    }
    if (opVal && Array.isArray(opVal.emails)) {
      const picked = pickPrimaryEmail(opVal.emails as ScimEmail[]);
      if (picked) email = picked;
    }
  }
  const normalized = authService.normalizeEmail(email);
  if (!normalized) return scimError(400, `'${email}' is not a valid email address`, "invalidValue");
  const result = await appDb.query<UserRow>(
    `UPDATE users
        SET email = $2,
            display_name = $3,
            is_active = $4,
            updated_at = NOW()
      WHERE id = $1
      RETURNING id, email, password_hash, display_name, is_active,
                last_login_at, created_at, updated_at`,
    [existing.id, normalized, displayName, active]
  );
  const updated = result.rows[0];
  await auditService
    .writeEvent({
      actorUserId,
      actorEmail: updated.email,
      targetUserId: updated.id,
      action: wasActive && !active ? "scim.user.deactivated" : "scim.user.updated",
      outcome: "success",
      details: { provider_id: providerId, active: updated.is_active },
      ipAddress,
      userAgent
    })
    .catch(() => {});
  const link = await appDb.query<{ subject: string }>(
    `SELECT subject FROM linked_identities WHERE provider_id = $1 AND user_id = $2`,
    [providerId, updated.id]
  );
  return { statusCode: 200, body: userToScim(updated, link.rows[0] && link.rows[0].subject) };
}

export async function deleteUser(
  { providerId, userId, actorUserId = null, ipAddress = null, userAgent = null }:
  Omit<ScimContextArgs, "body"> & { userId: string }
): Promise<ServiceResponse> {
  const existing = await findUserByExternalIdOrUserId(providerId, userId);
  if (!existing) return scimError(404, "user not found for this provider");
  await appDb.query(
    "UPDATE users SET is_active = FALSE, updated_at = NOW() WHERE id = $1",
    [existing.id]
  );
  await linkedIdentityService.unlink({ userId: existing.id, providerId }).catch(() => {});
  await auditService
    .writeEvent({
      actorUserId,
      actorEmail: existing.email,
      targetUserId: existing.id,
      action: "scim.user.deactivated",
      outcome: "success",
      details: { provider_id: providerId, method: "scim_delete" },
      ipAddress,
      userAgent
    })
    .catch(() => {});
  // SCIM 2.0 returns 204 No Content for a successful DELETE.
  return { statusCode: 204, body: null };
}

export async function findUserByExternalIdOrUserId(providerId: string, id: string): Promise<UserRow | null> {
  // SCIM resource IDs in our world are our `users.id` (UUID). But some IdPs
  // address by externalId; tolerate both lookups.
  const byId = await appDb.query<UserRow>(
    `SELECT u.id, u.email, u.display_name, u.is_active, u.created_at, u.updated_at
       FROM users u
       JOIN linked_identities li ON li.user_id = u.id
      WHERE u.id = $1 AND li.provider_id = $2`,
    [id, providerId]
  );
  if ((byId.rowCount ?? 0) > 0) return byId.rows[0];
  const byExternal = await findUserByExternalId(providerId, id);
  return byExternal || null;
}
