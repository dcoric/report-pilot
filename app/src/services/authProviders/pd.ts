import { randomBytes } from "crypto";
import appDb = require("../../lib/appDb");
import { findUserByEmail, verifyPassword, type AuthUserRow } from "../authService";
import type { ProviderRow } from "../authProviderService";
import type { AuthProviderService } from "./index";

interface PdFlowState {
  readonly provider_id: string;
  readonly state: string;
  readonly type: "pd";
}

interface PdPrincipal {
  readonly email: string;
  readonly display_name: string | null;
  readonly sub: string;
  readonly issuer: string;
  readonly username: string;
  readonly claims: Readonly<Record<string, unknown>>;
}

interface PdConnectionTestResult {
  readonly ok: boolean;
  readonly error?: string;
  readonly issuer?: string;
  readonly directory?: "local_password_directory";
  readonly password_users?: number;
}

interface PasswordDirectoryCountRow {
  readonly users: number | string;
}

class PdAuthError extends Error {
  readonly statusCode: number;

  constructor(message: string, statusCode: number) {
    super(message);
    this.name = "PdAuthError";
    this.statusCode = statusCode;
  }
}

const DEFAULT_ISSUER = "pd://local";

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function normalizeEmail(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim().toLowerCase() : null;
}

function normalizeString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function mappingValue(provider: ProviderRow | null | undefined, key: string): string | null {
  const value = provider?.claims_mapping?.[key];
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function firstStringClaim(claims: Readonly<Record<string, unknown>>, names: readonly string[]): string | null {
  for (const name of names) {
    const value = normalizeString(claims[name]);
    if (value) return value;
  }
  return null;
}

function mappedStringClaim(
  claims: Readonly<Record<string, unknown>>,
  mappedName: string | null,
  fallbackNames: readonly string[]
): string | null {
  if (mappedName) {
    const mapped = normalizeString(claims[mappedName]);
    if (mapped) return mapped;
  }
  return firstStringClaim(claims, fallbackNames);
}

function buildAuthorizeUrl(provider: ProviderRow, state: string): string {
  const url = new URL(provider.redirect_uri);
  url.searchParams.set("provider_id", provider.id);
  url.searchParams.set("provider_type", "pd");
  url.searchParams.set("state", state);
  return url.href;
}

function callbackCredential(currentUrl: string, name: string): string {
  const value = new URL(currentUrl).searchParams.get(name);
  if (!value || !value.trim()) throw new PdAuthError(`PD callback missing ${name}`, 400);
  return value.trim();
}

function claimsFromUser(user: AuthUserRow): Readonly<Record<string, unknown>> {
  return {
    id: user.id,
    sub: user.id,
    username: user.email,
    email: user.email,
    display_name: user.display_name,
    email_verified: true,
    password_directory: true
  };
}

function principalFromClaims(
  issuer: string,
  claims: Readonly<Record<string, unknown>>,
  provider: ProviderRow | null = null
): PdPrincipal {
  const email = normalizeEmail(mappedStringClaim(claims, mappingValue(provider, "email"), ["email", "username"]));
  if (!email) throw new PdAuthError("PD response missing mapped email or username claim", 400);
  const sub = mappedStringClaim(claims, mappingValue(provider, "sub"), ["sub", "id", "user_id", "email"]);
  if (!sub) throw new PdAuthError("PD response missing mapped subject claim", 400);
  return {
    email,
    display_name: mappedStringClaim(claims, mappingValue(provider, "display_name"), ["display_name", "displayName", "name"]),
    sub,
    issuer,
    username: mappedStringClaim(claims, mappingValue(provider, "username"), ["username", "email"]) ?? email,
    claims
  };
}

export class PdAuthProviderService implements AuthProviderService {
  type = "pd" as const;

  async startLogin(provider: ProviderRow): Promise<{ authorizeUrl: string; flowState: PdFlowState }> {
    if (!provider || !provider.enabled) throw new PdAuthError("provider is disabled or not found", 404);
    const state = randomBytes(24).toString("base64url");
    return { authorizeUrl: buildAuthorizeUrl(provider, state), flowState: { provider_id: provider.id, state, type: "pd" } };
  }

  async completeLogin(provider: ProviderRow, currentUrl: string, flowState: PdFlowState | null | undefined): Promise<PdPrincipal> {
    if (!provider) throw new PdAuthError("provider not found", 404);
    if (!flowState || flowState.provider_id !== provider.id || flowState.type !== "pd") throw new PdAuthError("invalid flow state", 400);
    const callbackUrl = new URL(currentUrl);
    const callbackState = callbackUrl.searchParams.get("state");
    if (callbackState && callbackState !== flowState.state) throw new PdAuthError("invalid flow state", 400);
    const username = callbackCredential(currentUrl, "username");
    const password = callbackCredential(currentUrl, "password");
    const user = await findUserByEmail(username);
    if (!user || !user.is_active || !user.password_hash || !verifyPassword(password, user.password_hash)) {
      throw new PdAuthError("invalid PD credentials", 401);
    }
    return principalFromClaims(provider.issuer || DEFAULT_ISSUER, claimsFromUser(user), provider);
  }

  async testConnection(provider: ProviderRow | null | undefined): Promise<PdConnectionTestResult> {
    if (!provider) return { ok: false, error: "provider not found", directory: "local_password_directory" };
    if (!provider.enabled) return { ok: false, error: "provider is disabled", issuer: provider.issuer || DEFAULT_ISSUER, directory: "local_password_directory" };
    try {
      const result = await appDb.query<PasswordDirectoryCountRow>("SELECT COUNT(*)::int AS users FROM users WHERE password_hash IS NOT NULL");
      const row = result.rows[0];
      const passwordUsers = row ? Number(row.users) : 0;
      return {
        ok: true,
        issuer: provider.issuer || DEFAULT_ISSUER,
        directory: "local_password_directory",
        password_users: Number.isFinite(passwordUsers) ? passwordUsers : 0
      };
    } catch (error) {
      return { ok: false, error: errorMessage(error), issuer: provider.issuer || DEFAULT_ISSUER, directory: "local_password_directory" };
    }
  }

  buildPrincipal(claims: Readonly<Record<string, unknown>>): PdPrincipal {
    return principalFromClaims(DEFAULT_ISSUER, claims);
  }
}
