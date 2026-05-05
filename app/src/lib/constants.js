const path = require("path");

const PORT = Number(process.env.PORT || 8080);

const LLM_PROVIDERS = new Set(["openai", "gemini", "deepseek", "openrouter"]);
const ENTITY_TYPES = new Set(["table", "column", "metric", "dimension", "rule"]);
const ROUTING_STRATEGIES = new Set(["ordered_fallback", "cost_optimized", "latency_optimized"]);
const SCHEMA_OBJECT_TYPES = new Set(["table", "view", "materialized_view"]);
const RELATIONSHIP_TYPES = new Set(["fk", "inferred"]);
const EXAMPLE_SOURCES = new Set(["manual", "feedback"]);
const EXPLAIN_BUDGET_ENABLED = String(process.env.EXPLAIN_BUDGET_ENABLED || "true") === "true";
const EXPLAIN_MAX_TOTAL_COST = Number(process.env.EXPLAIN_MAX_TOTAL_COST || 500000);
const EXPLAIN_MAX_PLAN_ROWS = Number(process.env.EXPLAIN_MAX_PLAN_ROWS || 1000000);
const RAG_NOTE_TITLE_MAX_LENGTH = 200;
const RAG_NOTE_CONTENT_MAX_LENGTH = 20000;
const SAVED_QUERY_NAME_MAX_LENGTH = 200;
const SAVED_QUERY_DESCRIPTION_MAX_LENGTH = 1000;
const SAVED_QUERY_DEFAULT_RUN_PARAM_KEYS = new Set(["llm_provider", "model", "max_rows", "timeout_ms", "no_execute"]);
const SAVED_QUERY_TAG_MAX_LENGTH = 40;
const SAVED_QUERY_MAX_TAGS = 20;
const PARAMETER_TYPES = new Set(["text", "integer", "decimal", "date", "boolean", "timestamp"]);
const PARAMETER_NAME_PATTERN = /^[a-z][a-z0-9_]*$/;
const MAX_PARAMETER_COUNT = 50;
const OPENAPI_SPEC_PATH = path.resolve(__dirname, "../../../docs/api/openapi.yaml");
const FRONTEND_DIST_PATH = path.resolve(__dirname, "../../../frontend/dist");
const FRONTEND_INDEX_PATH = path.join(FRONTEND_DIST_PATH, "index.html");
const STATIC_CONTENT_TYPES = {
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

module.exports = {
  PORT,
  LLM_PROVIDERS,
  ENTITY_TYPES,
  ROUTING_STRATEGIES,
  SCHEMA_OBJECT_TYPES,
  RELATIONSHIP_TYPES,
  EXAMPLE_SOURCES,
  EXPLAIN_BUDGET_ENABLED,
  EXPLAIN_MAX_TOTAL_COST,
  EXPLAIN_MAX_PLAN_ROWS,
  RAG_NOTE_TITLE_MAX_LENGTH,
  RAG_NOTE_CONTENT_MAX_LENGTH,
  SAVED_QUERY_NAME_MAX_LENGTH,
  SAVED_QUERY_DESCRIPTION_MAX_LENGTH,
  SAVED_QUERY_DEFAULT_RUN_PARAM_KEYS,
  SAVED_QUERY_TAG_MAX_LENGTH,
  SAVED_QUERY_MAX_TAGS,
  PARAMETER_TYPES,
  PARAMETER_NAME_PATTERN,
  MAX_PARAMETER_COUNT,
  OPENAPI_SPEC_PATH,
  FRONTEND_DIST_PATH,
  FRONTEND_INDEX_PATH,
  STATIC_CONTENT_TYPES
};
