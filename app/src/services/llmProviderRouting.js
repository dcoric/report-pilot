const appDb = require("../lib/appDb");
const { OpenAiAdapter } = require("../adapters/llm/openAiAdapter");
const { GeminiAdapter } = require("../adapters/llm/geminiAdapter");
const { DeepSeekAdapter } = require("../adapters/llm/deepSeekAdapter");
const { OpenRouterAdapter } = require("../adapters/llm/openRouterAdapter");
const { CustomAdapter } = require("../adapters/llm/customAdapter");
const { resolveApiKey } = require("../adapters/llm/httpClient");

const DEFAULT_PROVIDER_ORDER = ["openai", "gemini", "deepseek", "openrouter"];

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
  if (provider === "openrouter") {
    return new OpenRouterAdapter(opts);
  }
  if (providerConfig?.base_url) {
    return new CustomAdapter({
      ...opts,
      provider,
      baseUrl: providerConfig.base_url
    });
  }
  throw new Error(`Unsupported provider: ${provider}`);
}

async function loadProviderConfigs() {
  const result = await appDb.query(
    `
      SELECT provider, api_key_ref, default_model, base_url, display_name, enabled
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
  if (provider === "openrouter") {
    return resolveApiKey(ref, "OPENROUTER_API_KEY");
  }
  return resolveApiKey(ref, null);
}

module.exports = {
  buildAdapter,
  buildProviderOrder,
  loadProviderConfigs,
  loadRoutingRule
};
