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

import crypto from "crypto";
import appDb = require("../lib/appDb");

export const TOKEN_PREFIX = "scim_";
const TOKEN_BYTES = 32;
export const LABEL_MAX = 120;

export interface ScimTokenPublic {
  id: string;
  provider_id: string;
  label: string;
  created_at: Date | string;
  last_used_at: Date | string | null;
  revoked_at: Date | string | null;
}

export interface IssueTokenInput {
  providerId: string;
  label: string;
}

export type IssueTokenResult =
  | { ok: true; token: string; record: ScimTokenPublic }
  | { ok: false; code: "missing_provider" | "invalid_label"; message: string };

export interface RevokeTokenInput {
  providerId: string;
  tokenId: string;
}

export function generateRawToken(): string {
  const raw = crypto.randomBytes(TOKEN_BYTES).toString("base64url");
  return `${TOKEN_PREFIX}${raw}`;
}

export function hashToken(token: unknown): string | null {
  if (typeof token !== "string" || !token) return null;
  return crypto.createHash("sha256").update(token, "utf8").digest("hex");
}

function rowToPublic(row: Record<string, unknown> | null | undefined): ScimTokenPublic | null {
  if (!row) return null;
  return {
    id: row.id as string,
    provider_id: row.provider_id as string,
    label: row.label as string,
    created_at: row.created_at as Date | string,
    last_used_at: (row.last_used_at as Date | string | null) ?? null,
    revoked_at: (row.revoked_at as Date | string | null) ?? null
  };
}

function normalizeLabel(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > LABEL_MAX) return null;
  return trimmed;
}

export async function issueToken({ providerId, label }: IssueTokenInput): Promise<IssueTokenResult> {
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
  return { ok: true, token: raw, record: rowToPublic(result.rows[0]) as ScimTokenPublic };
}

export async function listForProvider(providerId: string | null | undefined): Promise<ScimTokenPublic[]> {
  if (!providerId) return [];
  const result = await appDb.query(
    `SELECT id, provider_id, label, created_at, last_used_at, revoked_at
       FROM scim_tokens
       WHERE provider_id = $1
       ORDER BY created_at DESC`,
    [providerId]
  );
  return result.rows.map(rowToPublic).filter((row): row is ScimTokenPublic => row !== null);
}

export async function revokeToken({ providerId, tokenId }: RevokeTokenInput): Promise<ScimTokenPublic | null> {
  if (!providerId || !tokenId) return null;
  const result = await appDb.query(
    `UPDATE scim_tokens
        SET revoked_at = COALESCE(revoked_at, NOW())
      WHERE id = $1 AND provider_id = $2
      RETURNING id, provider_id, label, created_at, last_used_at, revoked_at`,
    [tokenId, providerId]
  );
  return (result.rowCount ?? 0) > 0 ? rowToPublic(result.rows[0]) : null;
}

// Returns the active token row for a presented bearer token, or null. Bumps
// last_used_at as a side-effect on a successful match.
export async function verifyToken(presented: unknown): Promise<ScimTokenPublic | null> {
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
