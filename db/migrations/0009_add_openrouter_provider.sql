-- Add 'openrouter' to the allowed provider values in llm_providers and llm_routing_rules

ALTER TABLE llm_providers
  DROP CONSTRAINT IF EXISTS llm_providers_provider_check,
  ADD CONSTRAINT llm_providers_provider_check
    CHECK (provider IN ('openai', 'gemini', 'deepseek', 'openrouter'));

ALTER TABLE llm_routing_rules
  DROP CONSTRAINT IF EXISTS llm_routing_rules_primary_provider_check,
  ADD CONSTRAINT llm_routing_rules_primary_provider_check
    CHECK (primary_provider IN ('openai', 'gemini', 'deepseek', 'openrouter'));
