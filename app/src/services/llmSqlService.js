const appDb = require("../lib/appDb");
const { generateSqlFromQuestion } = require("./sqlGenerator");
const { OpenAiAdapter } = require("../adapters/llm/openAiAdapter");
const { GeminiAdapter } = require("../adapters/llm/geminiAdapter");
const { DeepSeekAdapter } = require("../adapters/llm/deepSeekAdapter");
const { resolveApiKey } = require("../adapters/llm/httpClient");

const DEFAULT_PROVIDER_ORDER = ["openai", "gemini", "deepseek"];

async function generateSqlWithRouting(input) {
  const {
    dataSourceId,
    question,
    maxRows,
    dialect,
    requestedProvider,
    requestedModel,
    schemaObjects,
    columns,
    semanticEntities,
    metricDefinitions,
    joinPolicies,
    ragDocuments
  } = input;

  const providerConfigs = await loadProviderConfigs();
  const routingRule = await loadRoutingRule(dataSourceId);
  const providerOrder = buildProviderOrder(requestedProvider, routingRule, providerConfigs);
  const prompt = buildSqlPrompt({
    dialect,
    question,
    maxRows,
    schemaObjects,
    columns,
    semanticEntities,
    metricDefinitions,
    joinPolicies,
    ragDocuments
  });

  const attempts = [];
  for (const provider of providerOrder) {
    const providerConfig = providerConfigs.get(provider) || null;

    const startedAt = Date.now();
    try {
      const adapter = buildAdapter(provider, providerConfig, requestedModel);
      const output = await adapter.generate({
        prompt,
        systemPrompt: buildSqlSystemPrompt(dialect),
        model: requestedModel || providerConfig?.default_model || undefined,
        temperature: 0,
        maxTokens: 900
      });

      const sql = String(output.text || "").trim();
      if (!sql) {
        throw new Error("Model returned empty SQL");
      }

      const usage = normalizeTokenUsage(output.usage);
      attempts.push({
        provider,
        model: output.model || requestedModel || providerConfig?.default_model || null,
        status: "success",
        latency_ms: Date.now() - startedAt,
        usage
      });

      return {
        sql,
        provider,
        model: output.model || requestedModel || providerConfig?.default_model || null,
        attempts,
        tokenUsage: usage,
        promptVersion: "v2-llm-router"
      };
    } catch (err) {
      attempts.push({
        provider,
        model: requestedModel || providerConfig?.default_model || null,
        status: "failed",
        latency_ms: Date.now() - startedAt,
        error: err.message
      });
    }
  }

  const allowFallback = String(process.env.ALLOW_RULE_BASED_FALLBACK || "true") === "true";
  if (!allowFallback) {
    const reasons = attempts.map((a) => `${a.provider}: ${a.error || "failed"}`).join("; ");
    throw new Error(`All LLM providers failed. Reasons: ${reasons}`);
  }

  const fallbackSql = generateSqlFromQuestion(question, schemaObjects, maxRows, dialect);
  attempts.push({
    provider: "local-fallback",
    model: "rule-based-v0",
    status: "success",
    latency_ms: 0,
    usage: null
  });

  return {
    sql: fallbackSql,
    provider: "local-fallback",
    model: "rule-based-v0",
    attempts,
    tokenUsage: null,
    promptVersion: "v2-llm-router"
  };
}

function buildProviderOrder(requestedProvider, routingRule, providerConfigs) {
  if (requestedProvider) {
    const order = [requestedProvider];
    const fallback = routingRule?.fallback_providers || [];
    for (const provider of fallback) {
      if (!order.includes(provider)) {
        order.push(provider);
      }
    }
    for (const provider of DEFAULT_PROVIDER_ORDER) {
      if (!order.includes(provider)) {
        order.push(provider);
      }
    }
    return filterEnabled(order, providerConfigs);
  }

  if (routingRule?.primary_provider) {
    const order = [routingRule.primary_provider];
    for (const provider of routingRule.fallback_providers || []) {
      if (!order.includes(provider)) {
        order.push(provider);
      }
    }
    for (const provider of DEFAULT_PROVIDER_ORDER) {
      if (!order.includes(provider)) {
        order.push(provider);
      }
    }
    return filterEnabled(order, providerConfigs);
  }

  return filterEnabled(DEFAULT_PROVIDER_ORDER.slice(), providerConfigs);
}

function filterEnabled(order, providerConfigs) {
  const enabled = order.filter((provider) => {
    const config = providerConfigs.get(provider);
    if (!config) {
      return true;
    }
    return config.enabled;
  });
  return enabled.length > 0 ? enabled : DEFAULT_PROVIDER_ORDER.slice();
}

function buildAdapter(provider, providerConfig, requestedModel) {
  const opts = {
    apiKey: resolveProviderApiKey(provider, providerConfig?.api_key_ref),
    defaultModel: requestedModel || providerConfig?.default_model
  };

  if (provider === "openai") {
    return new OpenAiAdapter(opts);
  }
  if (provider === "gemini") {
    return new GeminiAdapter(opts);
  }
  if (provider === "deepseek") {
    return new DeepSeekAdapter(opts);
  }
  throw new Error(`Unsupported provider: ${provider}`);
}

function resolveProviderApiKey(provider, ref) {
  if (provider === "openai") {
    return resolveApiKey(ref, "OPENAI_API_KEY");
  }
  if (provider === "gemini") {
    return resolveApiKey(ref, "GEMINI_API_KEY");
  }
  if (provider === "deepseek") {
    return resolveApiKey(ref, "DEEPSEEK_API_KEY");
  }
  return "";
}

async function loadProviderConfigs() {
  const result = await appDb.query(
    `
      SELECT provider, api_key_ref, default_model, enabled
      FROM llm_providers
    `
  );
  const map = new Map();
  for (const row of result.rows) {
    map.set(row.provider, row);
  }
  return map;
}

async function loadRoutingRule(dataSourceId) {
  const result = await appDb.query(
    `
      SELECT primary_provider, fallback_providers, strategy
      FROM llm_routing_rules
      WHERE data_source_id = $1
    `,
    [dataSourceId]
  );
  return result.rows[0] || null;
}

function buildSqlPrompt(context) {
  const dialect = String(context.dialect || "postgres").toLowerCase();
  const dialectLabel = dialect === "mssql" ? "Microsoft SQL Server (T-SQL)" : "PostgreSQL";

  const schemaLines = (context.schemaObjects || [])
    .slice(0, 40)
    .map((obj) => `- ${obj.schema_name}.${obj.object_name} (${obj.object_type})`);

  const columnLines = (context.columns || [])
    .slice(0, 120)
    .map((col) => `- ${col.schema_name}.${col.object_name}.${col.column_name} : ${col.data_type}`);

  const semanticLines = (context.semanticEntities || [])
    .slice(0, 50)
    .map((entity) => `- ${entity.business_name} -> ${entity.target_ref} (${entity.entity_type})`);

  const metricLines = (context.metricDefinitions || [])
    .slice(0, 30)
    .map((metric) => `- ${metric.business_name}: ${metric.sql_expression}`);

  const joinPolicyLines = (context.joinPolicies || [])
    .slice(0, 30)
    .map((policy) => `- ${policy.left_ref} ${policy.join_type} ${policy.right_ref} ON ${policy.on_clause}`);

  const ragLines = (context.ragDocuments || [])
    .slice(0, 16)
    .map((doc) => {
      const summary = String(doc.content || "")
        .split("\n")
        .slice(0, 6)
        .join("\n");
      return `- [${doc.doc_type}] ref=${doc.ref_id} score=${Number(doc.score || 0).toFixed(3)}\n${indent(summary, 2)}`;
    });

  return [
    "Task:",
    `Generate one ${dialectLabel} SELECT query for the user question.`,
    dialect === "mssql"
      ? `Apply TOP ${Number(context.maxRows)} if query can return multiple rows.`
      : `Apply LIMIT ${Number(context.maxRows)} if query can return multiple rows.`,
    "",
    "Rules:",
    "- Use only the schema objects listed below.",
    "- Prefer semantic mappings and metric definitions when relevant.",
    "- Never use INSERT, UPDATE, DELETE, ALTER, DROP, CREATE, TRUNCATE, GRANT, REVOKE.",
    "- Return SQL only. No markdown, no explanation.",
    "",
    `User question: ${context.question}`,
    "",
    "Schema objects:",
    schemaLines.length > 0 ? schemaLines.join("\n") : "- none",
    "",
    "Columns:",
    columnLines.length > 0 ? columnLines.join("\n") : "- none",
    "",
    "Semantic mappings:",
    semanticLines.length > 0 ? semanticLines.join("\n") : "- none",
    "",
    "Metric definitions:",
    metricLines.length > 0 ? metricLines.join("\n") : "- none",
    "",
    "Approved join policies:",
    joinPolicyLines.length > 0 ? joinPolicyLines.join("\n") : "- none",
    "",
    "Retrieved RAG context (highest relevance):",
    ragLines.length > 0 ? ragLines.join("\n") : "- none"
  ].join("\n");
}

function buildSqlSystemPrompt(dialect) {
  const normalized = String(dialect || "postgres").toLowerCase();
  if (normalized === "mssql") {
    return "Generate a single Microsoft SQL Server (T-SQL) SELECT query for reporting. Output only SQL, no explanation.";
  }
  return "Generate a single PostgreSQL SELECT query for reporting. Output only SQL, no explanation.";
}

function indent(text, spaces) {
  const prefix = " ".repeat(spaces);
  return String(text || "")
    .split("\n")
    .map((line) => `${prefix}${line}`)
    .join("\n");
}

function normalizeTokenUsage(raw) {
  if (!raw || typeof raw !== "object") {
    return null;
  }

  const promptTokens = toFiniteNumber(raw.prompt_tokens ?? raw.promptTokenCount);
  const completionTokens = toFiniteNumber(raw.completion_tokens ?? raw.candidatesTokenCount ?? raw.output_tokens);
  const totalTokens = toFiniteNumber(raw.total_tokens ?? raw.totalTokenCount);

  return {
    prompt_tokens: promptTokens || 0,
    completion_tokens: completionTokens || 0,
    total_tokens: totalTokens || (promptTokens || 0) + (completionTokens || 0)
  };
}

function toFiniteNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

module.exports = {
  generateSqlWithRouting
};
