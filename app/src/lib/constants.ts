import * as path from "path";

export const PORT: number = Number(process.env.PORT || 8080);

export const LLM_PROVIDERS: ReadonlySet<string> = new Set(["openai", "gemini", "deepseek", "openrouter"]);
export const ENTITY_TYPES: ReadonlySet<string> = new Set(["table", "column", "metric", "dimension", "rule"]);
export const ROUTING_STRATEGIES: ReadonlySet<string> = new Set(["ordered_fallback", "cost_optimized", "latency_optimized"]);
export const SCHEMA_OBJECT_TYPES: ReadonlySet<string> = new Set(["table", "view", "materialized_view"]);
export const RELATIONSHIP_TYPES: ReadonlySet<string> = new Set(["fk", "inferred"]);
export const EXAMPLE_SOURCES: ReadonlySet<string> = new Set(["manual", "feedback"]);
export const EXPLAIN_BUDGET_ENABLED: boolean = String(process.env.EXPLAIN_BUDGET_ENABLED || "true") === "true";
export const EXPLAIN_MAX_TOTAL_COST: number = Number(process.env.EXPLAIN_MAX_TOTAL_COST || 500000);
export const EXPLAIN_MAX_PLAN_ROWS: number = Number(process.env.EXPLAIN_MAX_PLAN_ROWS || 1000000);
export const RAG_NOTE_TITLE_MAX_LENGTH = 200 as const;
export const RAG_NOTE_CONTENT_MAX_LENGTH = 20000 as const;
export const SAVED_QUERY_NAME_MAX_LENGTH = 200 as const;
export const SAVED_QUERY_DESCRIPTION_MAX_LENGTH = 1000 as const;
export const SAVED_QUERY_DEFAULT_RUN_PARAM_KEYS: ReadonlySet<string> = new Set([
  "llm_provider",
  "model",
  "max_rows",
  "timeout_ms",
  "no_execute"
]);
export const SAVED_QUERY_TAG_MAX_LENGTH = 40 as const;
export const SAVED_QUERY_MAX_TAGS = 20 as const;
export const PARAMETER_TYPES: ReadonlySet<string> = new Set(["text", "integer", "decimal", "date", "boolean", "timestamp"]);
export const PARAMETER_NAME_PATTERN: RegExp = /^[a-z][a-z0-9_]*$/;
export const MAX_PARAMETER_COUNT = 50 as const;
export const OPENAPI_SPEC_PATH: string = path.resolve(__dirname, "../../../docs/api/openapi.yaml");
export const FRONTEND_DIST_PATH: string = path.resolve(__dirname, "../../../frontend/dist");
export const FRONTEND_INDEX_PATH: string = path.join(FRONTEND_DIST_PATH, "index.html");

export type StaticContentTypeMap = Readonly<Record<string, string>>;

export const STATIC_CONTENT_TYPES: StaticContentTypeMap = {
  ".css": "text/css; charset=utf-8",
  ".gif": "image/gif",
  ".html": "text/html; charset=utf-8",
  ".ico": "image/x-icon",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".txt": "text/plain; charset=utf-8",
  ".webp": "image/webp"
};
