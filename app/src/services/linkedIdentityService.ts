// AUTH-012: read / write helpers for the linked_identities table.
//
// All callers go through this module so the SQL stays in one place and the
// (provider_id, subject) uniqueness contract is honored.

import type { PoolClient } from "pg";
import appDb = require("../lib/appDb");

export interface LinkedIdentity {
  id: string;
  user_id: string;
  provider_id: string;
  subject: string;
  email_at_link: string | null;
  created_at: Date | string;
  last_seen_at: Date | string;
}

export interface LinkedIdentityWithProvider extends LinkedIdentity {
  provider: {
    id: string;
    name: string;
    display_name: string | null;
    type: string;
    enabled: boolean;
  };
}

export interface LinkIdentityInput {
  userId: string;
  providerId: string;
  subject: string;
  email?: string | null;
}

export interface UnlinkInput {
  userId: string;
  providerId: string;
}

function rowToIdentity(row: Record<string, unknown> | null): LinkedIdentity | null {
  if (!row) return null;
  return {
    id: row.id as string,
    user_id: row.user_id as string,
    provider_id: row.provider_id as string,
    subject: row.subject as string,
    email_at_link: (row.email_at_link as string | null) ?? null,
    created_at: row.created_at as Date | string,
    last_seen_at: row.last_seen_at as Date | string
  };
}

export async function findByProviderAndSubject(
  providerId: string | null | undefined,
  subject: string | null | undefined,
  client: PoolClient | null = null
): Promise<LinkedIdentity | null> {
  if (!providerId || !subject) return null;
  const exec = (client || appDb) as typeof appDb;
  const result = await exec.query(
    `SELECT id, user_id, provider_id, subject, email_at_link, created_at, last_seen_at
       FROM linked_identities
      WHERE provider_id = $1 AND subject = $2`,
    [providerId, subject]
  );
  return rowToIdentity(result.rows[0] || null);
}

// Records a new (user, provider, subject) link. If the same (provider, subject)
// already exists for a *different* user, the unique index trips a 23505 which
// callers translate into a "link_conflict" error.
export async function linkIdentity(
  { userId, providerId, subject, email }: LinkIdentityInput,
  client: PoolClient | null = null
): Promise<LinkedIdentity | null> {
  const exec = (client || appDb) as typeof appDb;
  const result = await exec.query(
    `INSERT INTO linked_identities (user_id, provider_id, subject, email_at_link)
     VALUES ($1, $2, $3, $4)
     RETURNING id, user_id, provider_id, subject, email_at_link, created_at, last_seen_at`,
    [userId, providerId, subject, email || null]
  );
  return rowToIdentity(result.rows[0]);
}

export async function touchLastSeen(id: string | null | undefined, client: PoolClient | null = null): Promise<void> {
  if (!id) return;
  const exec = (client || appDb) as typeof appDb;
  await exec.query(
    "UPDATE linked_identities SET last_seen_at = NOW() WHERE id = $1",
    [id]
  );
}

export async function listForUser(userId: string | null | undefined): Promise<LinkedIdentityWithProvider[]> {
  if (!userId) return [];
  const result = await appDb.query<Record<string, unknown>>(
    `SELECT li.id, li.user_id, li.provider_id, li.subject, li.email_at_link,
            li.created_at, li.last_seen_at,
            p.name AS provider_name, p.display_name AS provider_display_name,
            p.type AS provider_type, p.enabled AS provider_enabled
       FROM linked_identities li
       JOIN auth_providers p ON p.id = li.provider_id
      WHERE li.user_id = $1
      ORDER BY p.name`,
    [userId]
  );
  return result.rows.map((row) => ({
    ...(rowToIdentity(row) as LinkedIdentity),
    provider: {
      id: row.provider_id as string,
      name: row.provider_name as string,
      display_name: (row.provider_display_name as string | null) ?? null,
      type: row.provider_type as string,
      enabled: row.provider_enabled as boolean
    }
  }));
}

export async function unlink({ userId, providerId }: UnlinkInput): Promise<LinkedIdentity | null> {
  if (!userId || !providerId) return null;
  const result = await appDb.query(
    `DELETE FROM linked_identities
       WHERE user_id = $1 AND provider_id = $2
       RETURNING id, user_id, provider_id, subject, email_at_link`,
    [userId, providerId]
  );
  return (result.rowCount ?? 0) > 0 ? rowToIdentity(result.rows[0]) : null;
}
