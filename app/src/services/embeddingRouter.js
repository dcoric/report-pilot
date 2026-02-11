const { OpenAiAdapter } = require("../adapters/llm/openAiAdapter");
const { GeminiAdapter } = require("../adapters/llm/geminiAdapter");
const { resolveApiKey } = require("../adapters/llm/httpClient");
const { EMBEDDING_MODEL: LOCAL_EMBEDDING_MODEL, embedText } = require("./localEmbedding");

const OPENAI_DEFAULT_EMBED_MODEL = process.env.RAG_EMBED_MODEL_OPENAI || "text-embedding-3-small";
const GEMINI_DEFAULT_EMBED_MODEL = process.env.RAG_EMBED_MODEL_GEMINI || "text-embedding-004";

function buildEmbeddingModelId(provider, model) {
  if (provider === "local") {
    return LOCAL_EMBEDDING_MODEL;
  }
  return `${provider}:${model}`;
}

function parseEmbeddingModelId(embeddingModel) {
  const text = String(embeddingModel || "").trim();
  if (!text || text === LOCAL_EMBEDDING_MODEL) {
    return { provider: "local", model: LOCAL_EMBEDDING_MODEL };
  }

  const idx = text.indexOf(":");
  if (idx === -1) {
    return { provider: "local", model: LOCAL_EMBEDDING_MODEL };
  }

  return {
    provider: text.slice(0, idx),
    model: text.slice(idx + 1)
  };
}

function embedTextsLocal(texts) {
  return texts.map((text) => embedText(text));
}

async function embedTextsForIndexing(texts, opts = {}) {
  if (!Array.isArray(texts) || texts.length === 0) {
    return {
      provider: "local",
      embeddingModel: LOCAL_EMBEDDING_MODEL,
      vectors: []
    };
  }

  const preferred = String(opts.provider || process.env.RAG_EMBED_PROVIDER || "auto").toLowerCase();
  const order = providerOrder(preferred);

  for (const provider of order) {
    if (provider === "local") {
      return {
        provider: "local",
        embeddingModel: LOCAL_EMBEDDING_MODEL,
        vectors: embedTextsLocal(texts)
      };
    }

    try {
      const response = await embedTextsWithProvider(provider, texts);
      return response;
    } catch (err) {
      // try next provider
    }
  }

  return {
    provider: "local",
    embeddingModel: LOCAL_EMBEDDING_MODEL,
    vectors: embedTextsLocal(texts)
  };
}

async function embedQueryForModel(question, embeddingModel) {
  const parsed = parseEmbeddingModelId(embeddingModel);
  if (parsed.provider === "local") {
    return embedText(question);
  }

  try {
    const response = await embedTextsWithProvider(parsed.provider, [question], parsed.model);
    return response.vectors[0] || null;
  } catch {
    return null;
  }
}

async function embedTextsWithProvider(provider, texts, modelOverride) {
  if (provider === "openai") {
    const apiKey = resolveApiKey(process.env.RAG_EMBED_API_KEY_REF_OPENAI || "env:OPENAI_API_KEY", "OPENAI_API_KEY");
    if (!apiKey) {
      throw new Error("OpenAI embedding key is not configured");
    }
    const adapter = new OpenAiAdapter({
      apiKey,
      defaultModel: OPENAI_DEFAULT_EMBED_MODEL
    });
    const model = modelOverride || OPENAI_DEFAULT_EMBED_MODEL;
    const response = await adapter.embed({ texts, model });
    return {
      provider: "openai",
      embeddingModel: buildEmbeddingModelId("openai", response.model || model),
      vectors: response.vectors
    };
  }

  if (provider === "gemini") {
    const apiKey = resolveApiKey(process.env.RAG_EMBED_API_KEY_REF_GEMINI || "env:GEMINI_API_KEY", "GEMINI_API_KEY");
    if (!apiKey) {
      throw new Error("Gemini embedding key is not configured");
    }
    const adapter = new GeminiAdapter({
      apiKey,
      defaultModel: GEMINI_DEFAULT_EMBED_MODEL
    });
    const model = modelOverride || GEMINI_DEFAULT_EMBED_MODEL;
    const response = await adapter.embed({ texts, model });
    return {
      provider: "gemini",
      embeddingModel: buildEmbeddingModelId("gemini", response.model || model),
      vectors: response.vectors
    };
  }

  throw new Error(`Unsupported embedding provider: ${provider}`);
}

function providerOrder(preferred) {
  if (preferred === "openai") {
    return ["openai", "local"];
  }
  if (preferred === "gemini") {
    return ["gemini", "local"];
  }
  if (preferred === "local") {
    return ["local"];
  }
  return ["openai", "gemini", "local"];
}

module.exports = {
  LOCAL_EMBEDDING_MODEL,
  buildEmbeddingModelId,
  parseEmbeddingModelId,
  embedTextsForIndexing,
  embedQueryForModel
};
