import { randomBytes, scryptSync, createHash, timingSafeEqual } from "crypto";
import appDb = require("../lib/appDb");

const SCRYPT_KEYLEN = 64;
const SCRYPT_PARAMS = { N: 16384, r: 8, p: 1 };
const SESSION_TOKEN_BYTES = 32;
const DEFAULT_SESSION_DURATION_MS = 12 * 60 * 60 * 1000;
export const SESSION_COOKIE_NAME = "rp_session";
export const PASSWORD_MIN_LENGTH = 8;
export const PASSWORD_MAX_LENGTH = 256;
const EMAIL_MAX_LENGTH = 320;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export interface AuthUserRow {
  id: string;
  email: string;
  password_hash: string | null;
  display_name: string | null;
  is_active: boolean;
  last_login_at: Date | string | null;
  created_at: Date | string;
  updated_at: Date | string;
}

export interface PublicAuthUser {
  id: string;
  email: string;
  display_name: string | null;
  is_active: boolean;
  last_login_at: Date | string | null;
  created_at: Date | string;
  updated_at: Date | string;
}

export interface SessionRecord {
  token: string;
  sessionId: string;
  expiresAt: Date | string;
}

export interface ActiveSession {
  sessionId: string;
  expiresAt: Date | string;
  user: PublicAuthUser;
}

export interface CreateUserInput {
  email: unknown;
  password: unknown;
  displayName?: unknown;
}

export interface LoginInput {
  email: unknown;
  password: unknown;
  userAgent?: string | null;
  ipAddress?: string | null;
}

export interface LoginSuccess {
  user: PublicAuthUser;
  token: string;
  sessionId: string;
  expiresAt: Date | string;
}

export type PasswordPolicyResult =
  | { ok: true }
  | { ok: false; code: string; message: string };

export function getSessionDurationMs(): number {
  const raw = Number(process.env.AUTH_SESSION_DURATION_MS);
  if (Number.isFinite(raw) && raw > 0) {
    return raw;
  }
  return DEFAULT_SESSION_DURATION_MS;
}

export function normalizeEmail(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > EMAIL_MAX_LENGTH) {
    return null;
  }
  if (!EMAIL_PATTERN.test(trimmed)) {
    return null;
  }
  return trimmed.toLowerCase();
}

// AUTH-009: a tiny banned-passwords list. Reject the obvious top hits and the
// ones most often shown up in password-spray attempts against this app's
// length minimum. Kept short on purpose — we lean on length + char-class
// coverage for entropy, not on a giant denylist.
export const BANNED_PASSWORDS: ReadonlySet<string> = new Set([
  "password",
  "password1",
  "password!",
  "passw0rd",
  "qwerty123",
  "12345678",
  "123456789",
  "1234567890",
  "letmein!",
  "welcome1",
  "admin123",
  "iloveyou1"
]);

function passwordCharClasses(value: string): number {
  let classes = 0;
  if (/[a-z]/.test(value)) classes += 1;
  if (/[A-Z]/.test(value)) classes += 1;
  if (/[0-9]/.test(value)) classes += 1;
  // any non-alphanumeric, non-space character counts as a symbol
  if (/[^A-Za-z0-9\s]/.test(value)) classes += 1;
  return classes;
}

// Returns { ok: true } or { ok: false, code, message } with a stable error
// code so the API can map it onto a `400` response and the frontend onto a
// specific message.
export function checkPasswordPolicy(value: unknown, { email = null }: { email?: string | null } = {}): PasswordPolicyResult {
  if (typeof value !== "string") {
    return { ok: false, code: "invalid_password", message: "password must be a string" };
  }
  if (value.length < PASSWORD_MIN_LENGTH) {
    return {
      ok: false,
      code: "password_too_short",
      message: `password must be at least ${PASSWORD_MIN_LENGTH} characters`
    };
  }
  if (value.length > PASSWORD_MAX_LENGTH) {
    return {
      ok: false,
      code: "password_too_long",
      message: `password must be at most ${PASSWORD_MAX_LENGTH} characters`
    };
  }
  if (passwordCharClasses(value) < 2) {
    return {
      ok: false,
      code: "password_too_weak",
      message: "password must mix at least two of: lowercase, uppercase, digit, symbol"
    };
  }
  const lowered = value.toLowerCase();
  if (BANNED_PASSWORDS.has(lowered)) {
    return {
      ok: false,
      code: "password_banned",
      message: "password is on the common-passwords block list"
    };
  }
  if (typeof email === "string" && email.includes("@")) {
    const local = email.split("@")[0].toLowerCase();
    if (local && local.length >= 3 && lowered === local) {
      return {
        ok: false,
        code: "password_matches_email",
        message: "password must not match your email address"
      };
    }
  }
  return { ok: true };
}

export function validatePassword(value: unknown, options: { email?: string | null } = {}): boolean {
  return checkPasswordPolicy(value, options).ok;
}

export function hashPassword(password: unknown): string {
  const salt = randomBytes(16);
  const derived = scryptSync(password as string, salt, SCRYPT_KEYLEN, SCRYPT_PARAMS);
  return [
    "scrypt",
    SCRYPT_PARAMS.N,
    SCRYPT_PARAMS.r,
    SCRYPT_PARAMS.p,
    salt.toString("hex"),
    derived.toString("hex")
  ].join("$");
}

export function verifyPassword(password: unknown, encoded: unknown): boolean {
  if (typeof password !== "string" || typeof encoded !== "string") {
    return false;
  }
  const parts = encoded.split("$");
  if (parts.length !== 6 || parts[0] !== "scrypt") {
    return false;
  }
  const N = Number(parts[1]);
  const r = Number(parts[2]);
  const p = Number(parts[3]);
  if (!Number.isInteger(N) || !Number.isInteger(r) || !Number.isInteger(p)) {
    return false;
  }
  let salt: Buffer;
  let expected: Buffer;
  try {
    salt = Buffer.from(parts[4], "hex");
    expected = Buffer.from(parts[5], "hex");
  } catch {
    return false;
  }
  if (expected.length === 0) {
    return false;
  }
  let derived: Buffer;
  try {
    derived = scryptSync(password, salt, expected.length, { N, r, p });
  } catch {
    return false;
  }
  if (derived.length !== expected.length) {
    return false;
  }
  return timingSafeEqual(derived, expected);
}

export function generateSessionToken(): string {
  return randomBytes(SESSION_TOKEN_BYTES).toString("hex");
}

export function hashSessionToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

export function rowToUser(row: AuthUserRow | null | undefined): PublicAuthUser | null {
  if (!row) {
    return null;
  }
  return {
    id: row.id,
    email: row.email,
    display_name: row.display_name,
    is_active: row.is_active,
    last_login_at: row.last_login_at,
    created_at: row.created_at,
    updated_at: row.updated_at
  };
}

export async function findUserByEmail(email: unknown): Promise<AuthUserRow | null> {
  const normalized = normalizeEmail(email);
  if (!normalized) {
    return null;
  }
  const result = await appDb.query<AuthUserRow>(
    "SELECT id, email, password_hash, display_name, is_active, last_login_at, created_at, updated_at FROM users WHERE lower(email) = $1",
    [normalized]
  );
  return result.rows[0] || null;
}

export async function findUserById(id: unknown): Promise<AuthUserRow | null> {
  if (typeof id !== "string" || !id) {
    return null;
  }
  const result = await appDb.query<AuthUserRow>(
    "SELECT id, email, password_hash, display_name, is_active, last_login_at, created_at, updated_at FROM users WHERE id = $1",
    [id]
  );
  return result.rows[0] || null;
}

export async function createUser({ email, password, displayName = null }: CreateUserInput): Promise<AuthUserRow> {
  const normalized = normalizeEmail(email);
  if (!normalized) {
    const err = new Error("invalid email") as Error & { code: string };
    err.code = "invalid_email";
    throw err;
  }
  const policy = checkPasswordPolicy(password, { email: normalized });
  if (policy.ok !== true) {
    const { code, message } = policy;
    const err = new Error(message) as Error & { code: string };
    err.code = code;
    throw err;
  }
  const passwordHash = hashPassword(password);
  const trimmedDisplayName = typeof displayName === "string" && displayName.trim()
    ? displayName.trim()
    : null;
  const result = await appDb.query<AuthUserRow>(
    `
      INSERT INTO users (email, password_hash, display_name)
      VALUES ($1, $2, $3)
      RETURNING id, email, password_hash, display_name, is_active, last_login_at, created_at, updated_at
    `,
    [normalized, passwordHash, trimmedDisplayName]
  );
  return result.rows[0];
}

export async function createSession(userId: string, { userAgent = null, ipAddress = null }: { userAgent?: string | null; ipAddress?: string | null } = {}): Promise<SessionRecord> {
  const token = generateSessionToken();
  const tokenHash = hashSessionToken(token);
  const expiresAt = new Date(Date.now() + getSessionDurationMs());
  const trimmedAgent = typeof userAgent === "string" ? userAgent.slice(0, 1024) : null;
  const trimmedIp = typeof ipAddress === "string" ? ipAddress.slice(0, 64) : null;
  const result = await appDb.query<{ id: string; expires_at: Date | string }>(
    `
      INSERT INTO user_sessions (user_id, token_hash, user_agent, ip_address, expires_at)
      VALUES ($1, $2, $3, $4, $5)
      RETURNING id, expires_at
    `,
    [userId, tokenHash, trimmedAgent, trimmedIp, expiresAt.toISOString()]
  );
  return {
    token,
    sessionId: result.rows[0].id,
    expiresAt: result.rows[0].expires_at
  };
}

export async function findActiveSession(token: unknown): Promise<ActiveSession | null> {
  if (typeof token !== "string" || !token) {
    return null;
  }
  const tokenHash = hashSessionToken(token);
  const result = await appDb.query<AuthUserRow & {
    session_id: string;
    expires_at: Date | string;
    revoked_at: Date | string | null;
  }>(
    `
      SELECT
        s.id AS session_id,
        s.expires_at,
        s.revoked_at,
        u.id, u.email, u.password_hash, u.display_name, u.is_active,
        u.last_login_at, u.created_at, u.updated_at
      FROM user_sessions s
      JOIN users u ON u.id = s.user_id
      WHERE s.token_hash = $1
    `,
    [tokenHash]
  );
  const row = result.rows[0];
  if (!row) {
    return null;
  }
  if (row.revoked_at) {
    return null;
  }
  if (new Date(row.expires_at).getTime() <= Date.now()) {
    return null;
  }
  if (!row.is_active) {
    return null;
  }
  return {
    sessionId: row.session_id,
    expiresAt: row.expires_at,
    user: rowToUser(row) as PublicAuthUser
  };
}

export async function touchSession(sessionId: string): Promise<void> {
  await appDb.query(
    "UPDATE user_sessions SET last_seen_at = NOW() WHERE id = $1",
    [sessionId]
  );
}

export async function revokeSessionByToken(token: unknown): Promise<boolean> {
  if (typeof token !== "string" || !token) {
    return false;
  }
  const tokenHash = hashSessionToken(token);
  const result = await appDb.query(
    "UPDATE user_sessions SET revoked_at = NOW() WHERE token_hash = $1 AND revoked_at IS NULL",
    [tokenHash]
  );
  return (result.rowCount ?? 0) > 0;
}

export async function loginWithPassword({ email, password, userAgent, ipAddress }: LoginInput): Promise<LoginSuccess | null> {
  const user = await findUserByEmail(email);
  if (!user || !user.password_hash || !user.is_active) {
    return null;
  }
  if (!verifyPassword(password, user.password_hash)) {
    return null;
  }
  const session = await createSession(user.id, { userAgent, ipAddress });
  await appDb.query("UPDATE users SET last_login_at = NOW() WHERE id = $1", [user.id]);
  return {
    user: rowToUser(user) as PublicAuthUser,
    token: session.token,
    sessionId: session.sessionId,
    expiresAt: session.expiresAt
  };
}
