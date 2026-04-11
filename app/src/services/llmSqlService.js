const { generateSqlFromQuestion } = require("./sqlGenerator");
const {
  buildAdapter,
  buildProviderOrder,
  loadProviderConfigs,
  loadRoutingRule
} = require("./llmProviderRouting");
const { buildSqlPrompt, buildSqlSystemPrompt } = require("./llmPromptBuilder");
const { logLlmDebug, normalizeStatusCode, normalizeTokenUsage } = require("./llmDebug");

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
  const systemPrompt = buildSqlSystemPrompt(dialect);
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
  logLlmDebug({
    stage: "request_compiled",
    request_id: input.requestId || null,
    data_source_id: dataSourceId,
    question,
    requested_provider: requestedProvider || null,
    requested_model: requestedModel || null,
    provider_order: providerOrder,
    prompt,
    system_prompt: systemPrompt
  });

  const attempts = [];
  for (const provider of providerOrder) {
    const providerConfig = providerConfigs.get(provider) || null;

    const startedAt = Date.now();
    const model = requestedModel || providerConfig?.default_model || null;
    try {
      const adapter = buildAdapter(provider, providerConfig, requestedModel);
      logLlmDebug({
        stage: "provider_request",
        request_id: input.requestId || null,
        provider,
        model,
        temperature: 0,
        max_tokens: 900,
        prompt,
        system_prompt: systemPrompt
      });

      const output = await adapter.generate({
        prompt,
        systemPrompt: systemPrompt,
        model: model || undefined,
        temperature: 0,
        maxTokens: 900
      });

      const sql = String(output.text || "").trim();
      const latencyMs = Date.now() - startedAt;
      logLlmDebug({
        stage: "provider_response",
        request_id: input.requestId || null,
        provider,
        model: output.model || model,
        status_code: 200,
        latency_ms: latencyMs,
        usage: normalizeTokenUsage(output.usage),
        sql
      });
      if (!sql) {
        throw new Error("Model returned empty SQL");
      }

      const usage = normalizeTokenUsage(output.usage);
      attempts.push({
        provider,
        model: output.model || model,
        status: "success",
        status_code: 200,
        latency_ms: latencyMs,
        usage
      });

      return {
        sql,
        provider,
        model: output.model || model,
        attempts,
        tokenUsage: usage,
        promptVersion: "v2-llm-router"
      };
    } catch (err) {
      const latencyMs = Date.now() - startedAt;
      const statusCode = normalizeStatusCode(err?.statusCode);
      logLlmDebug({
        stage: "provider_error",
        request_id: input.requestId || null,
        provider,
        model,
        status_code: statusCode,
        latency_ms: latencyMs,
        error: err.message || String(err)
      });
      attempts.push({
        provider,
        model,
        status: "failed",
        status_code: statusCode,
        latency_ms: latencyMs,
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
    status_code: null,
    latency_ms: 0,
    usage: null
  });
  logLlmDebug({
    stage: "fallback_rule_based",
    request_id: input.requestId || null,
    provider: "local-fallback",
    model: "rule-based-v0",
    sql: fallbackSql
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
module.exports = {
  generateSqlWithRouting
};
