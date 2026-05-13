// AUTH-012: read / write helpers for the linked_identities table.
//
// All callers go through this module so the SQL stays in one place and the
// (provider_id, subject) uniqueness contract is honored.

const appDb = require("../lib/appDb");

function rowToIdentity(row) {
  if (!row) return null;
  return {
    id: row.id,
    user_id: row.user_id,
    provider_id: row.provider_id,
    subject: row.subject,
    email_at_link: row.email_at_link,
    created_at: row.created_at,
    last_seen_at: row.last_seen_at
  };
}

async function findByProviderAndSubject(providerId, subject, client = null) {
  if (!providerId || !subject) return null;
  const exec = client || appDb;
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
async function linkIdentity({ userId, providerId, subject, email }, client = null) {
  const exec = client || appDb;
  const result = await exec.query(
    `INSERT INTO linked_identities (user_id, provider_id, subject, email_at_link)
     VALUES ($1, $2, $3, $4)
     RETURNING id, user_id, provider_id, subject, email_at_link, created_at, last_seen_at`,
    [userId, providerId, subject, email || null]
  );
  return rowToIdentity(result.rows[0]);
}

async function touchLastSeen(id, client = null) {
  if (!id) return;
  const exec = client || appDb;
  await exec.query(
    "UPDATE linked_identities SET last_seen_at = NOW() WHERE id = $1",
    [id]
  );
}

async function listForUser(userId) {
  if (!userId) return [];
  const result = await appDb.query(
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
    ...rowToIdentity(row),
    provider: {
      id: row.provider_id,
      name: row.provider_name,
      display_name: row.provider_display_name,
      type: row.provider_type,
      enabled: row.provider_enabled
    }
  }));
}

async function unlink({ userId, providerId }) {
  if (!userId || !providerId) return null;
  const result = await appDb.query(
    `DELETE FROM linked_identities
       WHERE user_id = $1 AND provider_id = $2
       RETURNING id, user_id, provider_id, subject, email_at_link`,
    [userId, providerId]
  );
  return result.rowCount > 0 ? rowToIdentity(result.rows[0]) : null;
}

module.exports = {
  findByProviderAndSubject,
  linkIdentity,
  touchLastSeen,
  listForUser,
  unlink
};
