import type { PoolClient } from "pg";
import appDb = require("../lib/appDb");
import roleService = require("./roleService");

export interface UserWithAccess {
  id: string;
  email: string;
  display_name: string | null;
  is_active: boolean;
  granted_at: Date | string;
  granted_by_user_id: string | null;
  roles: string[];
}

export interface GrantRevokeArgs {
  userId: string;
  dataSourceId: string;
  actorUserId?: string | null;
}

export async function hasAccess(userId: string | null | undefined, dataSourceId: string | null | undefined): Promise<boolean> {
  if (!userId || !dataSourceId) {
    return false;
  }
  const result = await appDb.query(
    "SELECT 1 FROM user_data_source_access WHERE user_id = $1 AND data_source_id = $2",
    [userId, dataSourceId]
  );
  return (result.rowCount ?? 0) > 0;
}

export async function listAccessibleDataSourceIds(userId: string | null | undefined): Promise<string[]> {
  if (!userId) return [];
  const result = await appDb.query<{ data_source_id: string }>(
    "SELECT data_source_id FROM user_data_source_access WHERE user_id = $1",
    [userId]
  );
  return result.rows.map((row) => row.data_source_id);
}

export async function listUsersWithAccess(dataSourceId: string): Promise<UserWithAccess[]> {
  const result = await appDb.query<UserWithAccess>(
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

export async function grantAccess(client: PoolClient, { userId, dataSourceId, actorUserId }: GrantRevokeArgs): Promise<boolean> {
  const insert = await client.query(
    `
      INSERT INTO user_data_source_access (user_id, data_source_id, granted_by_user_id)
      VALUES ($1, $2, $3)
      ON CONFLICT (user_id, data_source_id) DO NOTHING
      RETURNING user_id
    `,
    [userId, dataSourceId, actorUserId || null]
  );
  const changed = (insert.rowCount ?? 0) > 0;
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

export async function revokeAccess(client: PoolClient, { userId, dataSourceId, actorUserId }: GrantRevokeArgs): Promise<boolean> {
  const del = await client.query(
    "DELETE FROM user_data_source_access WHERE user_id = $1 AND data_source_id = $2 RETURNING user_id",
    [userId, dataSourceId]
  );
  const changed = (del.rowCount ?? 0) > 0;
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
