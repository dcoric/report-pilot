import appDb = require("../lib/appDb");
import { OpenAiAdapter } from "../adapters/llm/openAiAdapter";
import { GeminiAdapter } from "../adapters/llm/geminiAdapter";
import { DeepSeekAdapter } from "../adapters/llm/deepSeekAdapter";
import { OpenRouterAdapter } from "../adapters/llm/openRouterAdapter";
import { CustomAdapter } from "../adapters/llm/customAdapter";
import { resolveApiKey } from "../adapters/llm/httpClient";
import type { LlmAdapter } from "../adapters/llm/types";

const DEFAULT_PROVIDER_ORDER = ["openai", "gemini", "deepseek", "openrouter"] as const;

export interface ProviderConfigRow {
  provider: string;
  api_key_ref: string | null;
  default_model: string | null;
  base_url: string | null;
  display_name: string | null;
  enabled: boolean;
}

export interface RoutingRule {
  primary_provider: string | null;
  fallback_providers: string[] | null;
  strategy: string | null;
}

export function buildProviderOrder(
  requestedProvider: string | null | undefined,
  routingRule: RoutingRule | null | undefined,
  providerConfigs: Map<string, ProviderConfigRow>
): string[] {
  if (requestedProvider) {
    const order: string[] = [requestedProvider];
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
    const order: string[] = [routingRule.primary_provider];
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

  return filterEnabled([...DEFAULT_PROVIDER_ORDER], providerConfigs);
}

export function buildAdapter(
  provider: string,
  providerConfig: ProviderConfigRow | null | undefined,
  requestedModel: string | null | undefined
): LlmAdapter {
  const opts = {
    apiKey: resolveProviderApiKey(provider, providerConfig?.api_key_ref ?? null),
    defaultModel: requestedModel || providerConfig?.default_model || undefined
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

export async function loadProviderConfigs(): Promise<Map<string, ProviderConfigRow>> {
  const result = await appDb.query<ProviderConfigRow>(
    `
      SELECT provider, api_key_ref, default_model, base_url, display_name, enabled
      FROM llm_providers
    `
  );
  const map = new Map<string, ProviderConfigRow>();
  for (const row of result.rows) {
    map.set(row.provider, row);
  }
  return map;
}

export async function loadRoutingRule(dataSourceId: string): Promise<RoutingRule | null> {
  const result = await appDb.query<RoutingRule>(
    `
      SELECT primary_provider, fallback_providers, strategy
      FROM llm_routing_rules
      WHERE data_source_id = $1
    `,
    [dataSourceId]
  );
  return result.rows[0] || null;
}

function filterEnabled(order: string[], providerConfigs: Map<string, ProviderConfigRow>): string[] {
  const enabled = order.filter((provider) => {
    const config = providerConfigs.get(provider);
    if (!config) {
      return true;
    }
    return config.enabled;
  });
  return enabled.length > 0 ? enabled : [...DEFAULT_PROVIDER_ORDER];
}

function resolveProviderApiKey(provider: string, ref: string | null | undefined): string | undefined {
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
