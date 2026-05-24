import type { PoolClient } from "pg";
import appDb = require("../lib/appDb");
import auditService = require("./auditService");

export const DEFAULT_ROLE = "viewer";
export const SYSTEM_ROLE_NAMES: ReadonlySet<string> = new Set(["admin", "analyst", "viewer"]);

export interface RoleRow {
  id: string;
  name: string;
  description: string | null;
  is_system: boolean;
  created_at?: Date | string;
  assigned_at?: Date | string;
}

export interface AssignRevokeRolesInput {
  userId: string;
  roleNames: unknown[];
  actorUserId?: string | null;
}

export interface AssignRolesResult {
  assigned: string[];
  skipped: string[];
}

export interface RevokeRolesResult {
  revoked: string[];
  skipped: string[];
}

interface AuditEntryArgs {
  actorUserId?: string | null;
  targetUserId: string;
  action: string;
  details?: Record<string, unknown>;
}

interface UnknownRoleError extends Error {
  code: "unknown_role";
  unknown: string[];
}

export function normalizeRoleName(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim().toLowerCase();
  return trimmed || null;
}

export function uniqueRoleNames(values: unknown): string[] | null {
  if (!Array.isArray(values)) {
    return null;
  }
  const seen = new Set<string>();
  const result: string[] = [];
  for (const entry of values) {
    const name = normalizeRoleName(entry);
    if (!name) {
      return null;
    }
    if (seen.has(name)) {
      continue;
    }
    seen.add(name);
    result.push(name);
  }
  return result;
}

export async function listRoles(): Promise<RoleRow[]> {
  const result = await appDb.query<RoleRow>(
    "SELECT id, name, description, is_system, created_at FROM roles ORDER BY name"
  );
  return result.rows;
}

export async function findRoleByName(name: unknown): Promise<RoleRow | null> {
  const normalized = normalizeRoleName(name);
  if (!normalized) {
    return null;
  }
  const result = await appDb.query<RoleRow>(
    "SELECT id, name, description, is_system FROM roles WHERE lower(name) = $1",
    [normalized]
  );
  return result.rows[0] || null;
}

export async function findRolesByNames(names: unknown): Promise<RoleRow[]> {
  if (!Array.isArray(names) || names.length === 0) {
    return [];
  }
  const normalized = names
    .map(normalizeRoleName)
    .filter((value): value is string => value !== null);
  if (normalized.length === 0) {
    return [];
  }
  const result = await appDb.query<RoleRow>(
    "SELECT id, name, description, is_system FROM roles WHERE lower(name) = ANY($1::text[])",
    [normalized]
  );
  return result.rows;
}

export async function listRolesForUser(userId: string, client: PoolClient | null = null): Promise<RoleRow[]> {
  const exec = (client || appDb) as typeof appDb;
  const result = await exec.query(
    `
      SELECT r.id, r.name, r.description, r.is_system, ur.assigned_at
      FROM user_roles ur
      JOIN roles r ON r.id = ur.role_id
      WHERE ur.user_id = $1
      ORDER BY r.name
    `,
    [userId]
  );
  return result.rows as RoleRow[];
}

export async function listRoleNamesForUser(userId: string, client: PoolClient | null = null): Promise<string[]> {
  const rows = await listRolesForUser(userId, client);
  return rows.map((row) => row.name);
}

export async function listPermissionNamesForUser(userId: string, client: PoolClient | null = null): Promise<string[]> {
  const exec = (client || appDb) as typeof appDb;
  const result = await exec.query(
    `
      SELECT DISTINCT p.name
      FROM user_roles ur
      JOIN role_permissions rp ON rp.role_id = ur.role_id
      JOIN permissions p ON p.id = rp.permission_id
      WHERE ur.user_id = $1
      ORDER BY p.name
    `,
    [userId]
  );
  return (result.rows as Array<{ name: string }>).map((row) => row.name);
}

export async function writeAuditEntry(client: PoolClient, { actorUserId, targetUserId, action, details = {} }: AuditEntryArgs): Promise<void> {
  // Thin shim kept for existing callers (role assignment, data source access).
  // New code paths should use auditService.writeEvent directly so they can
  // record outcome / IP / user-agent metadata too.
  await auditService.writeEvent(
    { actorUserId, targetUserId, action, details },
    client
  );
}

export async function assignRolesByName(client: PoolClient, { userId, roleNames, actorUserId }: AssignRevokeRolesInput): Promise<AssignRolesResult> {
  const distinct = uniqueRoleNames(roleNames) || [];
  if (distinct.length === 0) {
    return { assigned: [], skipped: [] };
  }
  const rolesResult = await client.query(
    "SELECT id, name FROM roles WHERE lower(name) = ANY($1::text[])",
    [distinct]
  );
  const foundRows = rolesResult.rows as RoleRow[];
  const found = new Map(foundRows.map((row) => [row.name, row]));
  const missing = distinct.filter((name) => !found.has(name));
  if (missing.length > 0) {
    const err = new Error(`unknown roles: ${missing.join(", ")}`) as UnknownRoleError;
    err.code = "unknown_role";
    err.unknown = missing;
    throw err;
  }

  const assigned: string[] = [];
  const skipped: string[] = [];
  for (const name of distinct) {
    const role = found.get(name)!;
    const insert = await client.query(
      `
        INSERT INTO user_roles (user_id, role_id, assigned_by_user_id)
        VALUES ($1, $2, $3)
        ON CONFLICT (user_id, role_id) DO NOTHING
        RETURNING role_id
      `,
      [userId, role.id, actorUserId || null]
    );
    if ((insert.rowCount ?? 0) > 0) {
      assigned.push(role.name);
      await writeAuditEntry(client, {
        actorUserId,
        targetUserId: userId,
        action: "role.assigned",
        details: { role: role.name }
      });
    } else {
      skipped.push(role.name);
    }
  }
  return { assigned, skipped };
}

export async function revokeRolesByName(client: PoolClient, { userId, roleNames, actorUserId }: AssignRevokeRolesInput): Promise<RevokeRolesResult> {
  const distinct = uniqueRoleNames(roleNames) || [];
  if (distinct.length === 0) {
    return { revoked: [], skipped: [] };
  }
  const rolesResult = await client.query(
    "SELECT id, name FROM roles WHERE lower(name) = ANY($1::text[])",
    [distinct]
  );
  const foundRows = rolesResult.rows as RoleRow[];
  const found = new Map(foundRows.map((row) => [row.name, row]));
  const missing = distinct.filter((name) => !found.has(name));
  if (missing.length > 0) {
    const err = new Error(`unknown roles: ${missing.join(", ")}`) as UnknownRoleError;
    err.code = "unknown_role";
    err.unknown = missing;
    throw err;
  }

  const revoked: string[] = [];
  const skipped: string[] = [];
  for (const name of distinct) {
    const role = found.get(name)!;
    const del = await client.query(
      "DELETE FROM user_roles WHERE user_id = $1 AND role_id = $2 RETURNING role_id",
      [userId, role.id]
    );
    if ((del.rowCount ?? 0) > 0) {
      revoked.push(role.name);
      await writeAuditEntry(client, {
        actorUserId,
        targetUserId: userId,
        action: "role.revoked",
        details: { role: role.name }
      });
    } else {
      skipped.push(role.name);
    }
  }
  return { revoked, skipped };
}
