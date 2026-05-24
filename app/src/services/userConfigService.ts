// AUTH-006: per-user configuration profiles.
//
// The on-disk shape is a JSONB blob keyed by user_id. This module is the
// single point of truth for "what's a valid config?" — the validator
// returns stable `code` values that map to a 400 response and a frontend
// inline error.

import appDb = require("../lib/appDb");

export interface UserConfig {
  default_data_source_id: string | null;
  default_llm_provider_id: string | null;
  default_model: string | null;
  max_rows: number;
  timeout_seconds: number;
  theme: "light" | "dark" | "system";
  table_preferences: Record<string, unknown>;
}

export type ValidateConfigResult =
  | { ok: true; value: UserConfig }
  | { ok: false; code: string; message: string };

export interface PutConfigResult {
  statusCode: number;
  body: UserConfig | { error: string; code?: string; message?: string };
}

export const VALID_THEMES: ReadonlySet<UserConfig["theme"]> = new Set(["light", "dark", "system"]);
const MAX_ROWS_FLOOR = 1;
const MAX_ROWS_CEIL = 10_000;
const TIMEOUT_FLOOR = 1;
const TIMEOUT_CEIL = 300;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const DEFAULT_CONFIG: Readonly<UserConfig> = Object.freeze({
  default_data_source_id: null,
  default_llm_provider_id: null,
  default_model: null,
  max_rows: 1000,
  timeout_seconds: 30,
  theme: "system",
  table_preferences: {}
}) as UserConfig;

export function defaultConfig(): UserConfig {
  return { ...DEFAULT_CONFIG, table_preferences: {} };
}

// Returns `{ ok: true, value }` or `{ ok: false, code, message }`. The
// caller can pass `partial: true` to omit fields without nulling them; we
// keep PUT-as-replace as the default since that matches the OpenAPI verb.
export function validateConfig(body: unknown, { partial = false }: { partial?: boolean } = {}): ValidateConfigResult {
  if (body == null || typeof body !== "object" || Array.isArray(body)) {
    return { ok: false, code: "invalid_body", message: "config must be a JSON object" };
  }
  const input = body as Record<string, unknown>;
  const value: UserConfig = partial
    ? ({} as UserConfig)
    : defaultConfig();

  if (Object.prototype.hasOwnProperty.call(input, "default_data_source_id")) {
    const raw = input.default_data_source_id;
    if (raw === null || raw === "") {
      value.default_data_source_id = null;
    } else if (typeof raw === "string" && UUID_RE.test(raw)) {
      value.default_data_source_id = raw;
    } else {
      return { ok: false, code: "invalid_default_data_source_id", message: "default_data_source_id must be a UUID or null" };
    }
  }

  if (Object.prototype.hasOwnProperty.call(input, "default_llm_provider_id")) {
    const raw = input.default_llm_provider_id;
    if (raw === null || raw === "") {
      value.default_llm_provider_id = null;
    } else if (typeof raw === "string" && UUID_RE.test(raw)) {
      value.default_llm_provider_id = raw;
    } else {
      return { ok: false, code: "invalid_default_llm_provider_id", message: "default_llm_provider_id must be a UUID or null" };
    }
  }

  if (Object.prototype.hasOwnProperty.call(input, "default_model")) {
    const raw = input.default_model;
    if (raw === null || raw === "") {
      value.default_model = null;
    } else if (typeof raw === "string" && raw.length <= 120) {
      value.default_model = raw.trim() || null;
    } else {
      return { ok: false, code: "invalid_default_model", message: "default_model must be a string up to 120 characters" };
    }
  }

  if (Object.prototype.hasOwnProperty.call(input, "max_rows")) {
    const raw = Number(input.max_rows);
    if (!Number.isInteger(raw) || raw < MAX_ROWS_FLOOR || raw > MAX_ROWS_CEIL) {
      return {
        ok: false,
        code: "invalid_max_rows",
        message: `max_rows must be an integer between ${MAX_ROWS_FLOOR} and ${MAX_ROWS_CEIL}`
      };
    }
    value.max_rows = raw;
  }

  if (Object.prototype.hasOwnProperty.call(input, "timeout_seconds")) {
    const raw = Number(input.timeout_seconds);
    if (!Number.isInteger(raw) || raw < TIMEOUT_FLOOR || raw > TIMEOUT_CEIL) {
      return {
        ok: false,
        code: "invalid_timeout_seconds",
        message: `timeout_seconds must be an integer between ${TIMEOUT_FLOOR} and ${TIMEOUT_CEIL}`
      };
    }
    value.timeout_seconds = raw;
  }

  if (Object.prototype.hasOwnProperty.call(input, "theme")) {
    const raw = input.theme;
    if (typeof raw !== "string" || !VALID_THEMES.has(raw as UserConfig["theme"])) {
      return {
        ok: false,
        code: "invalid_theme",
        message: `theme must be one of: ${[...VALID_THEMES].join(", ")}`
      };
    }
    value.theme = raw as UserConfig["theme"];
  }

  if (Object.prototype.hasOwnProperty.call(input, "table_preferences")) {
    const raw = input.table_preferences;
    if (raw === null || raw === undefined) {
      value.table_preferences = {};
    } else if (typeof raw !== "object" || Array.isArray(raw)) {
      return { ok: false, code: "invalid_table_preferences", message: "table_preferences must be an object" };
    } else {
      // Free-form. Cap the serialized size so we don't accept a 5 MB blob.
      const serialized = JSON.stringify(raw);
      if (serialized.length > 32 * 1024) {
        return { ok: false, code: "table_preferences_too_large", message: "table_preferences must be at most 32 KB serialized" };
      }
      value.table_preferences = raw as Record<string, unknown>;
    }
  }

  // Reject unknown keys so a typo in the payload doesn't silently no-op.
  const allowed = new Set(Object.keys(DEFAULT_CONFIG));
  for (const key of Object.keys(input)) {
    if (!allowed.has(key)) {
      return { ok: false, code: "unknown_field", message: `unknown config field: ${key}` };
    }
  }
  return { ok: true, value };
}

export async function getConfig(userId: string | null | undefined): Promise<UserConfig> {
  if (!userId) return defaultConfig();
  const result = await appDb.query<{ config: Partial<UserConfig> | null; updated_at: Date | string }>(
    "SELECT config, updated_at FROM user_configs WHERE user_id = $1",
    [userId]
  );
  if (result.rowCount === 0) {
    return defaultConfig();
  }
  // Merge over defaults so newly-added keys read sane values for users
  // whose row pre-dates the addition.
  return { ...defaultConfig(), ...(result.rows[0].config || {}) };
}

export async function putConfig(userId: string | null | undefined, body: unknown): Promise<PutConfigResult> {
  if (!userId) {
    return { statusCode: 401, body: { error: "unauthenticated" } };
  }
  const parsed = validateConfig(body);
  if (parsed.ok !== true) {
    const { code, message } = parsed;
    return { statusCode: 400, body: { error: "bad_request", code, message } };
  }

  // Verify the optional foreign-key targets actually exist so the GET path
  // never hands the UI a stale UUID. Done OUTSIDE the upsert so we return
  // a clean 400 rather than a 500 on a missing reference.
  if (parsed.value.default_data_source_id) {
    const exists = await appDb.query(
      "SELECT id FROM data_sources WHERE id = $1",
      [parsed.value.default_data_source_id]
    );
    if (exists.rowCount === 0) {
      return {
        statusCode: 400,
        body: {
          error: "bad_request",
          code: "unknown_default_data_source",
          message: "default_data_source_id does not match any existing data source"
        }
      };
    }
  }

  await appDb.query(
    `INSERT INTO user_configs (user_id, config, updated_at)
     VALUES ($1, $2::jsonb, NOW())
     ON CONFLICT (user_id) DO UPDATE
        SET config = EXCLUDED.config,
            updated_at = NOW()`,
    [userId, JSON.stringify(parsed.value)]
  );
  return { statusCode: 200, body: parsed.value };
}
