export type ParameterType = "text" | "integer" | "decimal" | "date" | "boolean" | "timestamp";

export interface ParameterSchemaEntry {
  name: string;
  type: ParameterType | string;
  required: boolean;
  default: unknown;
  allowed_values: unknown[] | null;
}

const PLACEHOLDER_REGEX = /(?<!:):([a-z][a-z0-9_]*)\b/gi;

function createDefaultParameterSchemaEntry(name: string): ParameterSchemaEntry {
  return {
    name,
    type: "text",
    required: true,
    default: null,
    allowed_values: null
  };
}

export function stripSingleQuotedLiterals(sql: unknown): string {
  const text = String(sql || "");
  let output = "";
  let index = 0;

  while (index < text.length) {
    if (text[index] !== "'") {
      output += text[index];
      index += 1;
      continue;
    }

    output += " ";
    index += 1;

    while (index < text.length) {
      output += " ";

      if (text[index] === "'" && text[index + 1] === "'") {
        output += " ";
        index += 2;
        continue;
      }

      if (text[index] === "'") {
        index += 1;
        break;
      }

      index += 1;
    }
  }

  return output;
}

export function extractPlaceholders(sql: string): string[] {
  const stripped = stripSingleQuotedLiterals(sql);
  const seen = new Set<string>();
  const placeholders: string[] = [];

  for (const match of stripped.matchAll(PLACEHOLDER_REGEX)) {
    const name = String(match[1] || "").toLowerCase();
    if (seen.has(name)) {
      continue;
    }
    seen.add(name);
    placeholders.push(name);
  }

  return placeholders;
}

export function buildParameterSchemaFromPlaceholders(
  placeholders: string[],
  existingSchema: ParameterSchemaEntry[] | unknown[] = []
): ParameterSchemaEntry[] {
  const existingMap = new Map<string, ParameterSchemaEntry>();
  for (const entry of Array.isArray(existingSchema) ? existingSchema : []) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry) || typeof (entry as Record<string, unknown>).name !== "string") {
      continue;
    }
    const e = entry as Record<string, unknown>;
    existingMap.set(e.name as string, {
      name: e.name as string,
      type: typeof e.type === "string" ? (e.type as string) : "text",
      required: e.required !== false,
      default: Object.prototype.hasOwnProperty.call(e, "default") ? e.default : null,
      allowed_values: Object.prototype.hasOwnProperty.call(e, "allowed_values") ? (e.allowed_values as unknown[] | null) : null
    });
  }

  return (Array.isArray(placeholders) ? placeholders : []).map((name) => existingMap.get(name) || createDefaultParameterSchemaEntry(name));
}

export function replaceNamedPlaceholders(sql: unknown, replacer: (placeholderName: string, match: string) => string | number | boolean | null): string {
  const text = String(sql || "");
  let output = "";
  let index = 0;

  while (index < text.length) {
    if (text[index] === "'") {
      output += "'";
      index += 1;

      while (index < text.length) {
        output += text[index];

        if (text[index] === "'" && text[index + 1] === "'") {
          output += "'";
          index += 2;
          continue;
        }

        if (text[index] === "'") {
          index += 1;
          break;
        }

        index += 1;
      }

      continue;
    }

    const slice = text.slice(index);
    const match = slice.match(/^:([a-z][a-z0-9_]*)\b/i);
    if (match && text[index - 1] !== ":") {
      const placeholderName = String(match[1] || "").toLowerCase();
      output += String(replacer(placeholderName, match[0]));
      index += match[0].length;
      continue;
    }

    output += text[index];
    index += 1;
  }

  return output;
}
