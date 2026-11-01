import type { ProviderConfig } from "../types/domain";

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function normalizedKey(key: string): string {
  return key.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function isSecretKey(key: string): boolean {
  const normalized = normalizedKey(key);
  return normalized.includes("secret")
    || normalized.includes("password")
    || normalized.includes("passphrase")
    || normalized.includes("privatekey")
    || normalized.includes("credential")
    || normalized.includes("apikey")
    || /tokens?(?:values?)?$/.test(normalized);
}

function redactValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((entry) => redactValue(entry));
  if (!isPlainObject(value)) return value;

  const redacted: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    redacted[key] = isSecretKey(key) ? "***" : redactValue(entry);
  }
  return redacted;
}

export function isPlainProviderConfig(value: unknown): value is ProviderConfig {
  return isPlainObject(value);
}

export function normalizeProviderConfig(value: unknown): ProviderConfig | null {
  if (value === undefined) return {};
  return isPlainProviderConfig(value) ? value : null;
}

export function normalizeStoredProviderConfig(value: unknown): ProviderConfig {
  return isPlainProviderConfig(value) ? value : {};
}

export function redactProviderConfig(value: ProviderConfig): ProviderConfig {
  const redacted = redactValue(value);
  return isPlainProviderConfig(redacted) ? redacted : {};
}
