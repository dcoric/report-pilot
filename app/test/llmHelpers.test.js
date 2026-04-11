const test = require("node:test");
const assert = require("node:assert/strict");

process.env.DATABASE_URL = process.env.DATABASE_URL || "postgresql://test:test@localhost:5432/test";

const { buildSqlPrompt, buildSqlSystemPrompt } = require("../src/services/llmPromptBuilder");
const { buildProviderOrder } = require("../src/services/llmProviderRouting");
const { normalizeTokenUsage } = require("../src/services/llmDebug");

test("buildSqlPrompt compiles dialect-specific instructions and retrieved context", () => {
  const prompt = buildSqlPrompt({
    dialect: "postgres",
    question: "Revenue by country",
    maxRows: 25,
    schemaObjects: [{ schema_name: "public", object_name: "orders", object_type: "table" }],
    columns: [{ schema_name: "public", object_name: "orders", column_name: "country", data_type: "text" }],
    semanticEntities: [{ business_name: "Revenue", target_ref: "metric.revenue", entity_type: "metric" }],
    metricDefinitions: [{ business_name: "Revenue", sql_expression: "sum(amount)" }],
    joinPolicies: [{ left_ref: "public.orders", join_type: "left", right_ref: "public.customers", on_clause: "orders.customer_id = customers.id" }],
    ragDocuments: [{ doc_type: "policy", ref_id: "note-1", score: 0.91, content: "Prefer net revenue\nExclude refunds" }]
  });

  assert.match(prompt, /Generate one PostgreSQL SELECT query/);
  assert.match(prompt, /Apply LIMIT 25/);
  assert.match(prompt, /User question: Revenue by country/);
  assert.match(prompt, /public\.orders \(table\)/);
  assert.match(prompt, /public\.orders\.country : text/);
  assert.match(prompt, /\[policy\] ref=note-1 score=0\.910/);
});

test("buildSqlSystemPrompt switches by dialect", () => {
  assert.match(buildSqlSystemPrompt("mssql"), /Microsoft SQL Server/);
  assert.match(buildSqlSystemPrompt("postgres"), /PostgreSQL/);
});

test("buildProviderOrder respects explicit provider, routing fallbacks, and enabled flags", () => {
  const providerConfigs = new Map([
    ["openai", { enabled: false }],
    ["gemini", { enabled: true }],
    ["deepseek", { enabled: true }],
    ["openrouter", { enabled: true }]
  ]);

  const order = buildProviderOrder(
    "openai",
    { fallback_providers: ["deepseek", "gemini"] },
    providerConfigs
  );

  assert.deepEqual(order, ["deepseek", "gemini", "openrouter"]);
});

test("normalizeTokenUsage supports provider-specific field names", () => {
  assert.deepEqual(
    normalizeTokenUsage({
      promptTokenCount: 11,
      candidatesTokenCount: 7
    }),
    {
      prompt_tokens: 11,
      completion_tokens: 7,
      total_tokens: 18
    }
  );
});
