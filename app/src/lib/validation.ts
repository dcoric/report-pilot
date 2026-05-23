import {
  SAVED_QUERY_DEFAULT_RUN_PARAM_KEYS,
  SCHEMA_OBJECT_TYPES,
  RELATIONSHIP_TYPES,
  ENTITY_TYPES,
  EXAMPLE_SOURCES
} from "./constants";

export function clamp(n: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, n));
}

export function isUuid(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

export function isNullableString(value: unknown): value is string | null {
  return value === null || typeof value === "string";
}

export function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

export function isInteger(value: unknown): value is number {
  return Number.isInteger(value);
}

export function isPgUniqueViolation(err: unknown): boolean {
  return Boolean(err && typeof err === "object" && (err as { code?: unknown }).code === "23505");
}

export function normalizeOptionalTrimmedString(value: unknown): string | null {
  if (value === undefined || value === null) {
    return null;
  }
  if (typeof value !== "string") {
    return null;
  }

  const trimmed = value.trim();
  return trimmed || null;
}

export type ValidationResult<T> =
  | { ok: true; value: T }
  | { ok: false; message: string };

export type SavedQueryDefaultRunParams = {
  llm_provider?: string;
  model?: string;
  max_rows?: number;
  timeout_ms?: number;
  no_execute?: boolean;
};

export function validateSavedQueryDefaultRunParams(value: unknown): ValidationResult<SavedQueryDefaultRunParams> {
  if (value === undefined) {
    return { ok: true, value: {} };
  }

  if (!isPlainObject(value)) {
    return { ok: false, message: "default_run_params must be an object" };
  }

  const normalized: SavedQueryDefaultRunParams = {};
  for (const [key, raw] of Object.entries(value)) {
    if (!SAVED_QUERY_DEFAULT_RUN_PARAM_KEYS.has(key)) {
      return { ok: false, message: "default_run_params contains unsupported keys" };
    }

    if (key === "llm_provider" || key === "model") {
      if (!isNonEmptyString(raw)) {
        return { ok: false, message: `default_run_params.${key} must be a non-empty string` };
      }
      normalized[key as "llm_provider" | "model"] = String(raw).trim();
      continue;
    }

    if (key === "max_rows") {
      if (!isInteger(raw) || (raw as number) < 1 || (raw as number) > 100000) {
        return { ok: false, message: "default_run_params.max_rows must be an integer between 1 and 100000" };
      }
      normalized.max_rows = raw as number;
      continue;
    }

    if (key === "timeout_ms") {
      if (!isInteger(raw) || (raw as number) < 1000 || (raw as number) > 120000) {
        return { ok: false, message: "default_run_params.timeout_ms must be an integer between 1000 and 120000" };
      }
      normalized.timeout_ms = raw as number;
      continue;
    }

    if (key === "no_execute") {
      if (typeof raw !== "boolean") {
        return { ok: false, message: "default_run_params.no_execute must be a boolean" };
      }
      normalized.no_execute = raw;
    }
  }

  return { ok: true, value: normalized };
}

export function groupByKey<T extends Record<string, unknown>>(rows: T[], key: keyof T): Record<string, T[]> {
  const map: Record<string, T[]> = {};
  for (const row of rows) {
    const k = String(row[key]);
    if (!map[k]) map[k] = [];
    map[k].push(row);
  }
  return map;
}

export function validateDataSourceImportPayload(body: unknown): string | null {
  if (!isPlainObject(body)) {
    return "Invalid export file: request body must be a JSON object";
  }
  if (!Number.isInteger((body as { version?: unknown }).version) || (body as { version: number }).version < 1) {
    return "Invalid export file: version must be a positive integer";
  }
  if (!isPlainObject((body as { data_source?: unknown }).data_source)) {
    return "Invalid export file: data_source must be an object";
  }

  const ds = (body as { data_source: Record<string, unknown> }).data_source;
  if (!isNonEmptyString(ds.name) || !isNonEmptyString(ds.db_type) || !isNonEmptyString(ds.connection_ref)) {
    return "data_source must include non-empty name, db_type and connection_ref";
  }

  const schemaObjects = (body as { schema_objects?: unknown }).schema_objects || [];
  if (!Array.isArray(schemaObjects)) {
    return "schema_objects must be an array";
  }
  for (let idx = 0; idx < schemaObjects.length; idx += 1) {
    const obj = schemaObjects[idx];
    if (!isPlainObject(obj)) {
      return `schema_objects[${idx}] must be an object`;
    }
    if (!SCHEMA_OBJECT_TYPES.has(obj.object_type as string)) {
      return `schema_objects[${idx}].object_type must be one of: table, view, materialized_view`;
    }
    if (!isNonEmptyString(obj.schema_name) || !isNonEmptyString(obj.object_name)) {
      return `schema_objects[${idx}] must include non-empty schema_name and object_name`;
    }
    if (!(obj.description === undefined || isNullableString(obj.description))) {
      return `schema_objects[${idx}].description must be a string or null`;
    }
    if (!(obj.is_ignored === undefined || typeof obj.is_ignored === "boolean")) {
      return `schema_objects[${idx}].is_ignored must be a boolean`;
    }
    if (!(obj.columns === undefined || Array.isArray(obj.columns))) {
      return `schema_objects[${idx}].columns must be an array`;
    }
    if (!(obj.relationships === undefined || Array.isArray(obj.relationships))) {
      return `schema_objects[${idx}].relationships must be an array`;
    }
    if (!(obj.indexes === undefined || Array.isArray(obj.indexes))) {
      return `schema_objects[${idx}].indexes must be an array`;
    }

    const columns = (obj.columns as unknown[]) || [];
    for (let colIdx = 0; colIdx < columns.length; colIdx += 1) {
      const col = columns[colIdx];
      if (!isPlainObject(col)) {
        return `schema_objects[${idx}].columns[${colIdx}] must be an object`;
      }
      if (!isNonEmptyString(col.column_name) || !isNonEmptyString(col.data_type)) {
        return `schema_objects[${idx}].columns[${colIdx}] must include non-empty column_name and data_type`;
      }
      if (typeof col.nullable !== "boolean" || typeof col.is_pk !== "boolean") {
        return `schema_objects[${idx}].columns[${colIdx}] must include boolean nullable and is_pk`;
      }
      if (!Number.isInteger(col.ordinal_position) || (col.ordinal_position as number) < 1) {
        return `schema_objects[${idx}].columns[${colIdx}].ordinal_position must be a positive integer`;
      }
    }

    const relationships = (obj.relationships as unknown[]) || [];
    for (let relIdx = 0; relIdx < relationships.length; relIdx += 1) {
      const rel = relationships[relIdx];
      if (!isPlainObject(rel)) {
        return `schema_objects[${idx}].relationships[${relIdx}] must be an object`;
      }
      if (
        !isNonEmptyString(rel.from_column) ||
        !isNonEmptyString(rel.to_schema) ||
        !isNonEmptyString(rel.to_object) ||
        !isNonEmptyString(rel.to_column)
      ) {
        return `schema_objects[${idx}].relationships[${relIdx}] must include non-empty from_column, to_schema, to_object and to_column`;
      }
      if (!RELATIONSHIP_TYPES.has(rel.relationship_type as string)) {
        return `schema_objects[${idx}].relationships[${relIdx}].relationship_type must be one of: fk, inferred`;
      }
    }

    const indexes = (obj.indexes as unknown[]) || [];
    for (let indexIdx = 0; indexIdx < indexes.length; indexIdx += 1) {
      const entry = indexes[indexIdx];
      if (!isPlainObject(entry)) {
        return `schema_objects[${idx}].indexes[${indexIdx}] must be an object`;
      }
      if (!isNonEmptyString(entry.index_name)) {
        return `schema_objects[${idx}].indexes[${indexIdx}].index_name must be a non-empty string`;
      }
      if (!Array.isArray(entry.columns) || (entry.columns as unknown[]).some((value) => !isNonEmptyString(value))) {
        return `schema_objects[${idx}].indexes[${indexIdx}].columns must be an array of non-empty strings`;
      }
      if (typeof entry.is_unique !== "boolean") {
        return `schema_objects[${idx}].indexes[${indexIdx}].is_unique must be a boolean`;
      }
    }
  }

  const ragNotes = (body as { rag_notes?: unknown }).rag_notes || [];
  if (!Array.isArray(ragNotes)) {
    return "rag_notes must be an array";
  }
  for (let idx = 0; idx < ragNotes.length; idx += 1) {
    const note = ragNotes[idx];
    if (!isPlainObject(note)) {
      return `rag_notes[${idx}] must be an object`;
    }
    if (!isNonEmptyString(note.title) || !isNonEmptyString(note.content)) {
      return `rag_notes[${idx}] must include non-empty title and content`;
    }
    if (!(note.active === undefined || typeof note.active === "boolean")) {
      return `rag_notes[${idx}].active must be a boolean`;
    }
  }

  const semanticEntities = (body as { semantic_entities?: unknown }).semantic_entities || [];
  if (!Array.isArray(semanticEntities)) {
    return "semantic_entities must be an array";
  }
  for (let idx = 0; idx < semanticEntities.length; idx += 1) {
    const entity = semanticEntities[idx];
    if (!isPlainObject(entity)) {
      return `semantic_entities[${idx}] must be an object`;
    }
    if (!ENTITY_TYPES.has(entity.entity_type as string)) {
      return `semantic_entities[${idx}].entity_type is invalid`;
    }
    if (!isNonEmptyString(entity.target_ref) || !isNonEmptyString(entity.business_name)) {
      return `semantic_entities[${idx}] must include non-empty target_ref and business_name`;
    }
    if (!(entity.description === undefined || isNullableString(entity.description))) {
      return `semantic_entities[${idx}].description must be a string or null`;
    }
    if (!(entity.owner === undefined || isNullableString(entity.owner))) {
      return `semantic_entities[${idx}].owner must be a string or null`;
    }
    if (!(entity.active === undefined || typeof entity.active === "boolean")) {
      return `semantic_entities[${idx}].active must be a boolean`;
    }
    if (!(entity.metric_definitions === undefined || Array.isArray(entity.metric_definitions))) {
      return `semantic_entities[${idx}].metric_definitions must be an array`;
    }
    const metricDefinitions = (entity.metric_definitions as unknown[]) || [];
    for (let metricIdx = 0; metricIdx < metricDefinitions.length; metricIdx += 1) {
      const metric = metricDefinitions[metricIdx];
      if (!isPlainObject(metric)) {
        return `semantic_entities[${idx}].metric_definitions[${metricIdx}] must be an object`;
      }
      if (!isNonEmptyString(metric.sql_expression)) {
        return `semantic_entities[${idx}].metric_definitions[${metricIdx}].sql_expression must be a non-empty string`;
      }
      if (!(metric.grain === undefined || isNullableString(metric.grain))) {
        return `semantic_entities[${idx}].metric_definitions[${metricIdx}].grain must be a string or null`;
      }
    }
  }

  const joinPolicies = (body as { join_policies?: unknown }).join_policies || [];
  if (!Array.isArray(joinPolicies)) {
    return "join_policies must be an array";
  }
  for (let idx = 0; idx < joinPolicies.length; idx += 1) {
    const policy = joinPolicies[idx];
    if (!isPlainObject(policy)) {
      return `join_policies[${idx}] must be an object`;
    }
    if (
      !isNonEmptyString(policy.left_ref) ||
      !isNonEmptyString(policy.right_ref) ||
      !isNonEmptyString(policy.join_type) ||
      !isNonEmptyString(policy.on_clause)
    ) {
      return `join_policies[${idx}] must include non-empty left_ref, right_ref, join_type and on_clause`;
    }
    if (!(policy.approved === undefined || typeof policy.approved === "boolean")) {
      return `join_policies[${idx}].approved must be a boolean`;
    }
    if (!(policy.notes === undefined || isNullableString(policy.notes))) {
      return `join_policies[${idx}].notes must be a string or null`;
    }
  }

  const examples = (body as { nl_sql_examples?: unknown }).nl_sql_examples || [];
  if (!Array.isArray(examples)) {
    return "nl_sql_examples must be an array";
  }
  for (let idx = 0; idx < examples.length; idx += 1) {
    const example = examples[idx];
    if (!isPlainObject(example)) {
      return `nl_sql_examples[${idx}] must be an object`;
    }
    if (!isNonEmptyString(example.question) || !isNonEmptyString(example.sql)) {
      return `nl_sql_examples[${idx}] must include non-empty question and sql`;
    }
    if (!(example.quality_score === undefined || example.quality_score === null || isFiniteNumber(example.quality_score))) {
      return `nl_sql_examples[${idx}].quality_score must be a number or null`;
    }
    if (!(example.source === undefined || EXAMPLE_SOURCES.has(example.source as string))) {
      return `nl_sql_examples[${idx}].source must be one of: manual, feedback`;
    }
  }

  const synonyms = (body as { synonyms?: unknown }).synonyms || [];
  if (!Array.isArray(synonyms)) {
    return "synonyms must be an array";
  }
  for (let idx = 0; idx < synonyms.length; idx += 1) {
    const synonym = synonyms[idx];
    if (!isPlainObject(synonym)) {
      return `synonyms[${idx}] must be an object`;
    }
    if (!isNonEmptyString(synonym.term) || !isNonEmptyString(synonym.maps_to_ref)) {
      return `synonyms[${idx}] must include non-empty term and maps_to_ref`;
    }
    if (!(synonym.weight === undefined || synonym.weight === null || isFiniteNumber(synonym.weight))) {
      return `synonyms[${idx}].weight must be a number or null`;
    }
  }

  return null;
}

export type SqlDialect = "postgres" | "mssql";

export function isLikelyInvalidSqlExecutionError(err: unknown, dialect: SqlDialect = "postgres"): boolean {
  const message = String((err as { message?: unknown })?.message || "");
  if (!message) {
    return false;
  }

  const commonPatterns = [
    /syntax error/i,
    /incorrect syntax/i
  ];
  const mssqlPatterns = [
    /invalid column name/i,
    /invalid object name/i,
    /ambiguous column name/i,
    /multi-part identifier .* could not be bound/i
  ];
  const postgresPatterns = [
    /column .* does not exist/i,
    /relation .* does not exist/i,
    /missing from-clause entry/i
  ];

  const patterns = dialect === "mssql"
    ? [...commonPatterns, ...mssqlPatterns]
    : [...commonPatterns, ...postgresPatterns];
  return patterns.some((pattern) => pattern.test(message));
}
