import { OpenAiAdapter } from "../adapters/llm/openAiAdapter";
import { GeminiAdapter } from "../adapters/llm/geminiAdapter";
import { resolveApiKey } from "../adapters/llm/httpClient";
import { EMBEDDING_MODEL as LOCAL_EMBEDDING_MODEL, embedText } from "./localEmbedding";

const OPENAI_DEFAULT_EMBED_MODEL = process.env.RAG_EMBED_MODEL_OPENAI || "text-embedding-3-small";
const GEMINI_DEFAULT_EMBED_MODEL = process.env.RAG_EMBED_MODEL_GEMINI || "text-embedding-004";

export type EmbeddingProvider = "local" | "openai" | "gemini" | "auto" | string;

export interface EmbedTextsResult {
  provider: EmbeddingProvider;
  embeddingModel: string;
  vectors: number[][];
}

export interface EmbedOptions {
  provider?: EmbeddingProvider;
}

export { LOCAL_EMBEDDING_MODEL };

export function buildEmbeddingModelId(provider: EmbeddingProvider, model: string | null | undefined): string {
  if (provider === "local") {
    return LOCAL_EMBEDDING_MODEL;
  }
  return `${provider}:${model}`;
}

export function parseEmbeddingModelId(embeddingModel: unknown): { provider: EmbeddingProvider; model: string } {
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

function embedTextsLocal(texts: string[]): number[][] {
  return texts.map((text) => embedText(text));
}

export async function embedTextsForIndexing(texts: string[], opts: EmbedOptions = {}): Promise<EmbedTextsResult> {
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
    } catch {
      // try next provider
    }
  }

  return {
    provider: "local",
    embeddingModel: LOCAL_EMBEDDING_MODEL,
    vectors: embedTextsLocal(texts)
  };
}

export async function embedQueryForModel(question: string, embeddingModel: string): Promise<number[] | null> {
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

async function embedTextsWithProvider(provider: string, texts: string[], modelOverride?: string): Promise<EmbedTextsResult> {
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

function providerOrder(preferred: string): string[] {
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
