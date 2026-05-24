import {
  PARAMETER_TYPES,
  PARAMETER_NAME_PATTERN,
  MAX_PARAMETER_COUNT
} from "../lib/constants";
import { replaceNamedPlaceholders, type ParameterSchemaEntry, type ParameterType } from "./queryParameterParser";

export type CoerceResult =
  | { ok: true; value: string | number | boolean | null }
  | { ok: false; message: string };

export type ValidateParameterSchemaResult =
  | { ok: true; value: ParameterSchemaEntry[] }
  | { ok: false; message: string };

export interface ValidationError {
  param: string | null;
  message: string;
}

export type ValidateParameterValuesResult =
  | { ok: true; resolvedValues: Record<string, string | number | boolean | null> }
  | { ok: false; errors: ValidationError[] };

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function parseDateOnly(value: unknown): string | null {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return null;
  }

  const [year, month, day] = value.split("-").map(Number);
  const parsed = new Date(Date.UTC(year, month - 1, day));
  if (
    parsed.getUTCFullYear() !== year
    || parsed.getUTCMonth() !== month - 1
    || parsed.getUTCDate() !== day
  ) {
    return null;
  }

  return value;
}

export function coerceParameterValue(type: ParameterType | string, value: unknown): CoerceResult {
  if (value === null || value === undefined) {
    return { ok: true, value: null };
  }

  if (type === "text") {
    if (typeof value === "string") {
      return { ok: true, value };
    }
    if (typeof value === "number" || typeof value === "boolean") {
      return { ok: true, value: String(value) };
    }
    return { ok: false, message: "must be a string" };
  }

  if (type === "integer") {
    if (typeof value === "number" && Number.isInteger(value)) {
      return { ok: true, value };
    }
    if (typeof value === "string" && /^[-+]?\d+$/.test(value.trim())) {
      const parsed = Number(value.trim());
      if (Number.isInteger(parsed)) {
        return { ok: true, value: parsed };
      }
    }
    return { ok: false, message: "must be an integer" };
  }

  if (type === "decimal") {
    if (typeof value === "number" && Number.isFinite(value)) {
      return { ok: true, value };
    }
    if (typeof value === "string" && value.trim()) {
      const parsed = Number(value.trim());
      if (Number.isFinite(parsed)) {
        return { ok: true, value: parsed };
      }
    }
    return { ok: false, message: "must be a decimal number" };
  }

  if (type === "date") {
    const normalized = parseDateOnly(typeof value === "string" ? value.trim() : value);
    if (normalized) {
      return { ok: true, value: normalized };
    }
    return { ok: false, message: "must be a valid date in YYYY-MM-DD format" };
  }

  if (type === "boolean") {
    if (typeof value === "boolean") {
      return { ok: true, value };
    }
    if (typeof value === "string") {
      const normalized = value.trim().toLowerCase();
      if (normalized === "true") {
        return { ok: true, value: true };
      }
      if (normalized === "false") {
        return { ok: true, value: false };
      }
    }
    return { ok: false, message: "must be true or false" };
  }

  if (type === "timestamp") {
    if (value instanceof Date && !Number.isNaN(value.getTime())) {
      return { ok: true, value: value.toISOString() };
    }
    if (typeof value === "string" && value.trim()) {
      const parsed = new Date(value.trim());
      if (!Number.isNaN(parsed.getTime())) {
        return { ok: true, value: parsed.toISOString() };
      }
    }
    return { ok: false, message: "must be a valid timestamp" };
  }

  return { ok: false, message: "has an unsupported type" };
}

export function validateParameterSchema(schema: unknown): ValidateParameterSchemaResult {
  if (schema === undefined) {
    return { ok: true, value: [] };
  }

  if (!Array.isArray(schema)) {
    return { ok: false, message: "parameter_schema must be an array" };
  }

  if (schema.length > MAX_PARAMETER_COUNT) {
    return { ok: false, message: `parameter_schema cannot contain more than ${MAX_PARAMETER_COUNT} parameters` };
  }

  const seenNames = new Set<string>();
  const normalized: ParameterSchemaEntry[] = [];

  for (const entry of schema) {
    if (!isPlainObject(entry)) {
      return { ok: false, message: "parameter_schema entries must be objects" };
    }

    const name = typeof entry.name === "string" ? entry.name.trim().toLowerCase() : "";
    if (!PARAMETER_NAME_PATTERN.test(name)) {
      return { ok: false, message: "parameter_schema names must match /^[a-z][a-z0-9_]*$/" };
    }
    if (seenNames.has(name)) {
      return { ok: false, message: `parameter_schema contains duplicate parameter name: ${name}` };
    }
    seenNames.add(name);

    const type = typeof entry.type === "string" ? entry.type.trim().toLowerCase() : "text";
    if (!(PARAMETER_TYPES as ReadonlySet<string>).has(type)) {
      return { ok: false, message: `parameter_schema.${name}.type is not supported` };
    }

    const required = entry.required === undefined ? true : entry.required;
    if (typeof required !== "boolean") {
      return { ok: false, message: `parameter_schema.${name}.required must be a boolean` };
    }

    const allowedValues = entry.allowed_values === undefined ? null : entry.allowed_values;
    if (allowedValues !== null && !Array.isArray(allowedValues)) {
      return { ok: false, message: `parameter_schema.${name}.allowed_values must be an array or null` };
    }

    let normalizedAllowedValues: unknown[] | null = null;
    if (Array.isArray(allowedValues)) {
      normalizedAllowedValues = [];
      const allowedSet = new Set<string>();
      for (const rawAllowedValue of allowedValues) {
        const coercedAllowedValue = coerceParameterValue(type, rawAllowedValue);
        if (!coercedAllowedValue.ok || coercedAllowedValue.value === null) {
          return { ok: false, message: `parameter_schema.${name}.allowed_values contains an invalid value` };
        }
        const key = JSON.stringify(coercedAllowedValue.value);
        if (allowedSet.has(key)) {
          continue;
        }
        allowedSet.add(key);
        normalizedAllowedValues.push(coercedAllowedValue.value);
      }
    }

    const defaultValue = entry.default === undefined ? null : entry.default;
    let normalizedDefaultValue: string | number | boolean | null = null;
    if (defaultValue !== null) {
      const coercedDefault = coerceParameterValue(type, defaultValue);
      if (coercedDefault.ok !== true) {
        const { message } = coercedDefault;
        return { ok: false, message: `parameter_schema.${name}.default ${message}` };
      }
      normalizedDefaultValue = coercedDefault.value;
    }

    if (normalizedAllowedValues && normalizedDefaultValue !== null) {
      const defaultKey = JSON.stringify(normalizedDefaultValue);
      const allowedKeys = new Set(normalizedAllowedValues.map((value) => JSON.stringify(value)));
      if (!allowedKeys.has(defaultKey)) {
        return { ok: false, message: `parameter_schema.${name}.default must be included in allowed_values` };
      }
    }

    normalized.push({
      name,
      type,
      required,
      default: normalizedDefaultValue,
      allowed_values: normalizedAllowedValues
    });
  }

  return { ok: true, value: normalized };
}

export function validateParameterValues(parameterSchema: unknown, suppliedValues: unknown): ValidateParameterValuesResult {
  const schemaValidation = validateParameterSchema(parameterSchema);
  if (schemaValidation.ok !== true) {
    return {
      ok: false,
      errors: [{ param: null, message: schemaValidation.message }]
    };
  }

  if (suppliedValues !== undefined && !isPlainObject(suppliedValues)) {
    return {
      ok: false,
      errors: [{ param: null, message: "params must be an object" }]
    };
  }

  const params = (suppliedValues as Record<string, unknown> | undefined) || {};
  const resolvedValues: Record<string, string | number | boolean | null> = {};
  const errors: ValidationError[] = [];
  const knownNames = new Set(schemaValidation.value.map((entry) => entry.name));

  for (const entry of schemaValidation.value) {
    const hasSuppliedValue = Object.prototype.hasOwnProperty.call(params, entry.name);
    const rawValue = hasSuppliedValue ? params[entry.name] : undefined;

    if (rawValue === undefined || rawValue === null) {
      if (entry.default !== null) {
        resolvedValues[entry.name] = entry.default as string | number | boolean | null;
        continue;
      }
      if (entry.required) {
        errors.push({ param: entry.name, message: "is required" });
        continue;
      }
      resolvedValues[entry.name] = null;
      continue;
    }

    const coerced = coerceParameterValue(entry.type, rawValue);
    if (coerced.ok !== true) {
      const { message } = coerced;
      errors.push({ param: entry.name, message });
      continue;
    }

    if (entry.allowed_values) {
      const allowedKeys = new Set(entry.allowed_values.map((value) => JSON.stringify(value)));
      if (!allowedKeys.has(JSON.stringify(coerced.value))) {
        errors.push({ param: entry.name, message: "must be one of the allowed values" });
        continue;
      }
    }

    resolvedValues[entry.name] = coerced.value;
  }

  for (const name of Object.keys(params)) {
    if (!knownNames.has(name)) {
      errors.push({ param: name, message: "is not defined in parameter_schema" });
    }
  }

  if (errors.length > 0) {
    return { ok: false, errors };
  }

  return { ok: true, resolvedValues };
}

export function substitutePlaceholdersForValidation(sql: string, parameterSchema: unknown): string {
  const schemaValidation = validateParameterSchema(parameterSchema);
  const schema = schemaValidation.ok ? schemaValidation.value : [];
  const schemaByName = new Map(schema.map((entry) => [entry.name, entry]));

  return replaceNamedPlaceholders(sql, (name) => {
    const type = schemaByName.get(name)?.type || "text";

    if (type === "integer") {
      return "0";
    }
    if (type === "decimal") {
      return "0.0";
    }
    if (type === "date") {
      return "'1900-01-01'";
    }
    if (type === "boolean") {
      return "1";
    }
    if (type === "timestamp") {
      return "'1900-01-01T00:00:00.000Z'";
    }
    return "'x'";
  });
}
