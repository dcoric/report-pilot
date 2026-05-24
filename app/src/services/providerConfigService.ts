export interface ProviderUpsertInput {
  provider: string;
  apiKeyRef: string;
  defaultModel: string;
  baseUrl: string | null;
  displayName: string | null;
  enabled: boolean;
}

export interface ExistingProvider {
  api_key_ref?: string | null;
  base_url?: string | null;
  display_name?: string | null;
  [key: string]: unknown;
}

interface BadRequestError extends Error {
  statusCode: number;
}

function createBadRequestError(message: string): BadRequestError {
  const err = new Error(message) as BadRequestError;
  err.statusCode = 400;
  return err;
}

export function normalizeProviderUpsertInput(
  body: unknown,
  existingProvider: ExistingProvider | null | undefined,
  knownProviders: ReadonlySet<string>
): ProviderUpsertInput {
  const requestBody = (body && typeof body === "object" ? body : {}) as Record<string, unknown>;
  const provider = typeof requestBody.provider === "string" ? requestBody.provider.trim() : "";
  const defaultModel = typeof requestBody.default_model === "string" ? requestBody.default_model.trim() : "";
  const requestedBaseUrl =
    typeof requestBody.base_url === "string" && requestBody.base_url.trim() ? requestBody.base_url.trim() : null;
  const requestedDisplayName =
    typeof requestBody.display_name === "string" && requestBody.display_name.trim()
      ? requestBody.display_name.trim()
      : null;
  const { enabled } = requestBody;
  const apiKeyRefProvided = Object.prototype.hasOwnProperty.call(requestBody, "api_key_ref");
  const requestedApiKeyRef = typeof requestBody.api_key_ref === "string" ? requestBody.api_key_ref.trim() : "";

  if (!provider || !defaultModel || typeof enabled !== "boolean") {
    throw createBadRequestError("provider, default_model, enabled are required");
  }

  if (apiKeyRefProvided && !requestedApiKeyRef) {
    throw createBadRequestError("api_key_ref must be a non-empty string");
  }

  const apiKeyRef = apiKeyRefProvided ? requestedApiKeyRef : existingProvider?.api_key_ref || "";
  if (!apiKeyRef) {
    throw createBadRequestError("api_key_ref is required");
  }

  const isKnown = knownProviders.has(provider);
  const baseUrl = isKnown ? null : requestedBaseUrl || existingProvider?.base_url || null;
  const displayName = isKnown ? null : requestedDisplayName || existingProvider?.display_name || null;
  const isCustom = !isKnown && Boolean(baseUrl);

  if (!isKnown && !isCustom) {
    throw createBadRequestError("Invalid provider");
  }
  if (requestedBaseUrl && isKnown) {
    throw createBadRequestError("base_url is only allowed for custom providers");
  }
  if (isCustom && !/^https?:\/\/.+/.test(baseUrl as string)) {
    throw createBadRequestError("Invalid base_url");
  }

  return {
    provider,
    apiKeyRef,
    defaultModel,
    baseUrl,
    displayName,
    enabled
  };
}
