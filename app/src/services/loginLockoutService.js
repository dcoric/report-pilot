// AUTH-009: account / IP lockout backed by the AUTH-008 audit log.
//
// Why query the audit log instead of a new table?
//   * Failed logins are already recorded there with `outcome='failure'`,
//     `actor_email`, and `ip_address`, and the table is indexed on
//     (outcome, created_at DESC). One read per login attempt is acceptable
//     for a human-scale login endpoint.
//   * Anything we'd add to a separate "lockout" table (counters, last_seen)
//     is derivable from the same audit rows, so a second source of truth
//     would just risk drift.
//
// Policy:
//   * Track the last WINDOW_MS of failures per (actor_email) and per
//     (ip_address). If either count is >= THRESHOLD, the request is locked
//     for WINDOW_MS measured from the most recent failure.
//   * A successful login (`auth.login.success`) for the same actor_email
//     inside the window resets the email-side count — we only block on
//     consecutive failures, not on a stale failure that preceded a recovery.
//     IP-side block is NOT reset by a single successful login from another
//     account, since the IP could be sweeping addresses.
//
// All constants are overridable via env vars so deployments / tests can
// dial the behavior without code edits.

const appDb = require("../lib/appDb");

const DEFAULTS = {
  windowMs: 15 * 60 * 1000,
  emailThreshold: 5,
  ipThreshold: 20
};

function readPositiveInt(name, fallback) {
  const raw = Number(process.env[name]);
  if (Number.isFinite(raw) && raw > 0) return Math.floor(raw);
  return fallback;
}

function getConfig() {
  return {
    windowMs: readPositiveInt("AUTH_LOCKOUT_WINDOW_MS", DEFAULTS.windowMs),
    emailThreshold: readPositiveInt("AUTH_LOCKOUT_EMAIL_THRESHOLD", DEFAULTS.emailThreshold),
    ipThreshold: readPositiveInt("AUTH_LOCKOUT_IP_THRESHOLD", DEFAULTS.ipThreshold)
  };
}

function normalizeEmail(email) {
  if (typeof email !== "string") return null;
  const trimmed = email.trim().toLowerCase();
  return trimmed || null;
}

function normalizeIp(ipAddress) {
  if (typeof ipAddress !== "string") return null;
  const trimmed = ipAddress.trim();
  return trimmed || null;
}

// Returns `{ locked: false }` when the request may proceed, or
// `{ locked: true, reason, retryAfterSeconds }` when it must be rejected.
async function checkLockout({ email, ipAddress } = {}) {
  const config = getConfig();
  const normalizedEmail = normalizeEmail(email);
  const normalizedIp = normalizeIp(ipAddress);
  if (!normalizedEmail && !normalizedIp) {
    return { locked: false };
  }

  const sinceIso = new Date(Date.now() - config.windowMs).toISOString();

  if (normalizedEmail) {
    // Count failures since the most recent success (so a successful login
    // clears the email-side strike count).
    const result = await appDb.query(
      `
        WITH recent AS (
          SELECT outcome, created_at
          FROM auth_audit_log
          WHERE action IN ('auth.login.failure', 'auth.login.success')
            AND lower(actor_email) = $1
            AND created_at >= $2
        ),
        last_success AS (
          SELECT MAX(created_at) AS at FROM recent WHERE outcome = 'success'
        )
        SELECT
          COUNT(*) FILTER (
            WHERE outcome = 'failure'
              AND created_at > COALESCE((SELECT at FROM last_success), 'epoch')
          )::int AS failures,
          MAX(created_at) FILTER (
            WHERE outcome = 'failure'
              AND created_at > COALESCE((SELECT at FROM last_success), 'epoch')
          ) AS last_failure_at
        FROM recent
      `,
      [normalizedEmail, sinceIso]
    );
    const row = result.rows[0] || { failures: 0, last_failure_at: null };
    if (row.failures >= config.emailThreshold) {
      return buildLocked("too_many_failed_logins", row.last_failure_at, config.windowMs);
    }
  }

  if (normalizedIp) {
    const result = await appDb.query(
      `
        SELECT
          COUNT(*)::int AS failures,
          MAX(created_at) AS last_failure_at
        FROM auth_audit_log
        WHERE action = 'auth.login.failure'
          AND outcome = 'failure'
          AND ip_address = $1
          AND created_at >= $2
      `,
      [normalizedIp, sinceIso]
    );
    const row = result.rows[0] || { failures: 0, last_failure_at: null };
    if (row.failures >= config.ipThreshold) {
      return buildLocked("ip_throttled", row.last_failure_at, config.windowMs);
    }
  }

  return { locked: false };
}

function buildLocked(reason, lastFailureAt, windowMs) {
  let retryAfterSeconds = Math.ceil(windowMs / 1000);
  if (lastFailureAt) {
    const last = lastFailureAt instanceof Date
      ? lastFailureAt.getTime()
      : new Date(lastFailureAt).getTime();
    if (Number.isFinite(last)) {
      const remainingMs = (last + windowMs) - Date.now();
      retryAfterSeconds = Math.max(1, Math.ceil(remainingMs / 1000));
    }
  }
  return { locked: true, reason, retryAfterSeconds };
}

module.exports = {
  DEFAULTS,
  getConfig,
  checkLockout
};
