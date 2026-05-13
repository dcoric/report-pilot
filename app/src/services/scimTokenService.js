// AUTH-013: bearer-token issuance and verification for SCIM 2.0 endpoints.
//
// Tokens are 256 random bits, encoded as 43 url-safe base64 characters and
// prefixed with `scim_` so they're visually distinguishable from session
// tokens. Only the SHA-256 hash is stored — the plaintext returned from
// `issueToken` is the one and only time the admin will see it.
//
// Verification looks the token up by hash, refuses revoked / unknown
// tokens, and bumps `last_used_at` for observability. The function returns
// the matched row (with the bound provider id) so the route handler can
// attribute SCIM activity.

const crypto = require("crypto");
const appDb = require("../lib/appDb");

const TOKEN_PREFIX = "scim_";
const TOKEN_BYTES = 32;
const LABEL_MAX = 120;

function generateRawToken() {
  const raw = crypto.randomBytes(TOKEN_BYTES).toString("base64url");
  return `${TOKEN_PREFIX}${raw}`;
}

function hashToken(token) {
  if (typeof token !== "string" || !token) return null;
  return crypto.createHash("sha256").update(token, "utf8").digest("hex");
}

function rowToPublic(row) {
  if (!row) return null;
  return {
    id: row.id,
    provider_id: row.provider_id,
    label: row.label,
    created_at: row.created_at,
    last_used_at: row.last_used_at,
    revoked_at: row.revoked_at
  };
}

function normalizeLabel(value) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > LABEL_MAX) return null;
  return trimmed;
}

async function issueToken({ providerId, label }) {
  const normalized = normalizeLabel(label);
  if (!providerId) {
    return { ok: false, code: "missing_provider", message: "provider_id is required" };
  }
  if (!normalized) {
    return { ok: false, code: "invalid_label", message: `label is required, up to ${LABEL_MAX} characters` };
  }
  const raw = generateRawToken();
  const hash = hashToken(raw);
  const result = await appDb.query(
    `INSERT INTO scim_tokens (provider_id, label, token_hash)
     VALUES ($1, $2, $3)
     RETURNING id, provider_id, label, created_at, last_used_at, revoked_at`,
    [providerId, normalized, hash]
  );
  return { ok: true, token: raw, record: rowToPublic(result.rows[0]) };
}

async function listForProvider(providerId) {
  if (!providerId) return [];
  const result = await appDb.query(
    `SELECT id, provider_id, label, created_at, last_used_at, revoked_at
       FROM scim_tokens
       WHERE provider_id = $1
       ORDER BY created_at DESC`,
    [providerId]
  );
  return result.rows.map(rowToPublic);
}

async function revokeToken({ providerId, tokenId }) {
  if (!providerId || !tokenId) return null;
  const result = await appDb.query(
    `UPDATE scim_tokens
        SET revoked_at = COALESCE(revoked_at, NOW())
      WHERE id = $1 AND provider_id = $2
      RETURNING id, provider_id, label, created_at, last_used_at, revoked_at`,
    [tokenId, providerId]
  );
  return result.rowCount > 0 ? rowToPublic(result.rows[0]) : null;
}

// Returns the active token row for a presented bearer token, or null. Bumps
// last_used_at as a side-effect on a successful match.
async function verifyToken(presented) {
  const hash = hashToken(presented);
  if (!hash) return null;
  const result = await appDb.query(
    `SELECT id, provider_id, label, token_hash, created_at, last_used_at, revoked_at
       FROM scim_tokens
      WHERE token_hash = $1`,
    [hash]
  );
  const row = result.rows[0];
  if (!row || row.revoked_at) return null;
  // Best-effort last_used_at bump; failure here must not break the request.
  appDb
    .query("UPDATE scim_tokens SET last_used_at = NOW() WHERE id = $1", [row.id])
    .catch(() => {});
  return rowToPublic(row);
}

module.exports = {
  TOKEN_PREFIX,
  LABEL_MAX,
  hashToken,
  generateRawToken,
  issueToken,
  listForProvider,
  revokeToken,
  verifyToken
};
