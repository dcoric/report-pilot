const appDb = require("../lib/appDb");
const roleService = require("./roleService");

async function hasAccess(userId, dataSourceId) {
  if (!userId || !dataSourceId) {
    return false;
  }
  const result = await appDb.query(
    "SELECT 1 FROM user_data_source_access WHERE user_id = $1 AND data_source_id = $2",
    [userId, dataSourceId]
  );
  return result.rowCount > 0;
}

async function listAccessibleDataSourceIds(userId) {
  if (!userId) return [];
  const result = await appDb.query(
    "SELECT data_source_id FROM user_data_source_access WHERE user_id = $1",
    [userId]
  );
  return result.rows.map((row) => row.data_source_id);
}

async function listUsersWithAccess(dataSourceId) {
  const result = await appDb.query(
    `
      SELECT
        u.id,
        u.email,
        u.display_name,
        u.is_active,
        a.granted_at,
        a.granted_by_user_id,
        COALESCE(
          (
            SELECT array_agg(r.name ORDER BY r.name)
            FROM user_roles ur
            JOIN roles r ON r.id = ur.role_id
            WHERE ur.user_id = u.id
          ),
          ARRAY[]::text[]
        ) AS roles
      FROM user_data_source_access a
      JOIN users u ON u.id = a.user_id
      WHERE a.data_source_id = $1
      ORDER BY lower(u.email)
    `,
    [dataSourceId]
  );
  return result.rows.map((row) => ({
    id: row.id,
    email: row.email,
    display_name: row.display_name,
    is_active: row.is_active,
    granted_at: row.granted_at,
    granted_by_user_id: row.granted_by_user_id,
    roles: row.roles
  }));
}

async function grantAccess(client, { userId, dataSourceId, actorUserId }) {
  const insert = await client.query(
    `
      INSERT INTO user_data_source_access (user_id, data_source_id, granted_by_user_id)
      VALUES ($1, $2, $3)
      ON CONFLICT (user_id, data_source_id) DO NOTHING
      RETURNING user_id
    `,
    [userId, dataSourceId, actorUserId || null]
  );
  const changed = insert.rowCount > 0;
  if (changed) {
    await roleService.writeAuditEntry(client, {
      actorUserId,
      targetUserId: userId,
      action: "data_source.access.granted",
      details: { data_source_id: dataSourceId }
    });
  }
  return changed;
}

async function revokeAccess(client, { userId, dataSourceId, actorUserId }) {
  const del = await client.query(
    "DELETE FROM user_data_source_access WHERE user_id = $1 AND data_source_id = $2 RETURNING user_id",
    [userId, dataSourceId]
  );
  const changed = del.rowCount > 0;
  if (changed) {
    await roleService.writeAuditEntry(client, {
      actorUserId,
      targetUserId: userId,
      action: "data_source.access.revoked",
      details: { data_source_id: dataSourceId }
    });
  }
  return changed;
}

module.exports = {
  hasAccess,
  listAccessibleDataSourceIds,
  listUsersWithAccess,
  grantAccess,
  revokeAccess
};
