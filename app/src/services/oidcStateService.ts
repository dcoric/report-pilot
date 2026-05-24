// AUTH-015: replay protection for the OIDC authorization code flow.
//
// The signed flow cookie alone isn't enough — once captured (e.g. a stolen
// laptop / browser dump within the TTL window) it can be replayed against
// the callback endpoint. We persist a hash of every state value we've seen
// at callback time, and refuse any callback whose state we've already
// recorded.
//
// Two helpers, both keyed on a SHA-256 hash so the raw state is never
// persisted:
//
//   recordUsedState({ state, providerId, expiresAt })
//     Inserts the row. If the state is already present we return
//     `{ replayed: true }` and the caller refuses the callback. We sweep
//     expired rows opportunistically here so the table stays bounded.
//
//   pruneExpired()
//     Exposed for tests / a future scheduled sweep. Safe to call any time.

import { createHash } from "crypto";
import appDb = require("../lib/appDb");

const DEFAULT_GRACE_MS = 60 * 1000;

export interface RecordUsedStateInput {
  state: string;
  providerId: string | null;
  expiresAt: Date | number | string;
}

export interface RecordUsedStateResult {
  replayed: boolean;
  ok: boolean;
  reason?: string;
}

export function hashState(state: unknown): string | null {
  if (typeof state !== "string" || !state) return null;
  return createHash("sha256").update(state, "utf8").digest("hex");
}

export async function recordUsedState({ state, providerId, expiresAt }: RecordUsedStateInput): Promise<RecordUsedStateResult> {
  const hash = hashState(state);
  if (!hash) {
    return { replayed: false, ok: false, reason: "invalid_state" };
  }
  const expiry = expiresAt instanceof Date
    ? expiresAt
    : new Date(Number(expiresAt) || (Date.now() + DEFAULT_GRACE_MS));
  if (Number.isNaN(expiry.getTime())) {
    return { replayed: false, ok: false, reason: "invalid_expiry" };
  }

  try {
    await appDb.query(
      `INSERT INTO oidc_used_states (state_hash, provider_id, expires_at)
       VALUES ($1, $2, $3)`,
      [hash, providerId || null, expiry.toISOString()]
    );
  } catch (err) {
    if (err && (err as { code?: string }).code === "23505") {
      return { replayed: true, ok: false, reason: "state_replayed" };
    }
    throw err;
  }

  // Opportunistic prune — keeps the table bounded without needing a cron.
  // Best-effort; failure here must not block the login.
  pruneExpired().catch(() => {});
  return { replayed: false, ok: true };
}

export async function pruneExpired(): Promise<void> {
  await appDb.query("DELETE FROM oidc_used_states WHERE expires_at < NOW()");
}
