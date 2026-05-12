const appDb = require("../lib/appDb");
const auditService = require("./auditService");

const DEFAULT_ROLE = "viewer";
const SYSTEM_ROLE_NAMES = new Set(["admin", "analyst", "viewer"]);

function normalizeRoleName(value) {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim().toLowerCase();
  return trimmed || null;
}

function uniqueRoleNames(values) {
  if (!Array.isArray(values)) {
    return null;
  }
  const seen = new Set();
  const result = [];
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

async function listRoles() {
  const result = await appDb.query(
    "SELECT id, name, description, is_system, created_at FROM roles ORDER BY name"
  );
  return result.rows;
}

async function findRoleByName(name) {
  const normalized = normalizeRoleName(name);
  if (!normalized) {
    return null;
  }
  const result = await appDb.query(
    "SELECT id, name, description, is_system FROM roles WHERE lower(name) = $1",
    [normalized]
  );
  return result.rows[0] || null;
}

async function findRolesByNames(names) {
  if (!Array.isArray(names) || names.length === 0) {
    return [];
  }
  const normalized = names
    .map(normalizeRoleName)
    .filter((value) => value !== null);
  if (normalized.length === 0) {
    return [];
  }
  const result = await appDb.query(
    "SELECT id, name, description, is_system FROM roles WHERE lower(name) = ANY($1::text[])",
    [normalized]
  );
  return result.rows;
}

async function listRolesForUser(userId, client = null) {
  const exec = client || appDb;
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
  return result.rows;
}

async function listRoleNamesForUser(userId, client = null) {
  const rows = await listRolesForUser(userId, client);
  return rows.map((row) => row.name);
}

async function listPermissionNamesForUser(userId, client = null) {
  const exec = client || appDb;
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
  return result.rows.map((row) => row.name);
}

async function writeAuditEntry(client, { actorUserId, targetUserId, action, details = {} }) {
  // Thin shim kept for existing callers (role assignment, data source access).
  // New code paths should use auditService.writeEvent directly so they can
  // record outcome / IP / user-agent metadata too.
  await auditService.writeEvent(
    { actorUserId, targetUserId, action, details },
    client
  );
}

async function assignRolesByName(client, { userId, roleNames, actorUserId }) {
  const distinct = uniqueRoleNames(roleNames) || [];
  if (distinct.length === 0) {
    return { assigned: [], skipped: [] };
  }
  const rolesResult = await client.query(
    "SELECT id, name FROM roles WHERE lower(name) = ANY($1::text[])",
    [distinct]
  );
  const found = new Map(rolesResult.rows.map((row) => [row.name, row]));
  const missing = distinct.filter((name) => !found.has(name));
  if (missing.length > 0) {
    const err = new Error(`unknown roles: ${missing.join(", ")}`);
    err.code = "unknown_role";
    err.unknown = missing;
    throw err;
  }

  const assigned = [];
  const skipped = [];
  for (const name of distinct) {
    const role = found.get(name);
    const insert = await client.query(
      `
        INSERT INTO user_roles (user_id, role_id, assigned_by_user_id)
        VALUES ($1, $2, $3)
        ON CONFLICT (user_id, role_id) DO NOTHING
        RETURNING role_id
      `,
      [userId, role.id, actorUserId || null]
    );
    if (insert.rowCount > 0) {
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

async function revokeRolesByName(client, { userId, roleNames, actorUserId }) {
  const distinct = uniqueRoleNames(roleNames) || [];
  if (distinct.length === 0) {
    return { revoked: [], skipped: [] };
  }
  const rolesResult = await client.query(
    "SELECT id, name FROM roles WHERE lower(name) = ANY($1::text[])",
    [distinct]
  );
  const found = new Map(rolesResult.rows.map((row) => [row.name, row]));
  const missing = distinct.filter((name) => !found.has(name));
  if (missing.length > 0) {
    const err = new Error(`unknown roles: ${missing.join(", ")}`);
    err.code = "unknown_role";
    err.unknown = missing;
    throw err;
  }

  const revoked = [];
  const skipped = [];
  for (const name of distinct) {
    const role = found.get(name);
    const del = await client.query(
      "DELETE FROM user_roles WHERE user_id = $1 AND role_id = $2 RETURNING role_id",
      [userId, role.id]
    );
    if (del.rowCount > 0) {
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

module.exports = {
  DEFAULT_ROLE,
  SYSTEM_ROLE_NAMES,
  normalizeRoleName,
  uniqueRoleNames,
  listRoles,
  findRoleByName,
  findRolesByNames,
  listRolesForUser,
  listRoleNamesForUser,
  listPermissionNamesForUser,
  assignRolesByName,
  revokeRolesByName,
  writeAuditEntry
};
