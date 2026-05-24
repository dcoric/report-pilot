const DEFAULT_DIM = Number(process.env.RAG_EMBED_DIM || 64);
export const EMBEDDING_MODEL = "local-hash-v1";

export function embedText(text: unknown, dim: number = DEFAULT_DIM): number[] {
  const tokens = tokenize(text);
  const vector: number[] = new Array(dim).fill(0);

  if (tokens.length === 0) {
    return vector;
  }

  for (const token of tokens) {
    const index = Math.abs(hash(token)) % dim;
    vector[index] += 1;
  }

  return normalize(vector);
}

export function cosineSimilarity(a: number[] | unknown, b: number[] | unknown): number {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length === 0 || b.length === 0) {
    return 0;
  }
  const len = Math.min(a.length, b.length);
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < len; i += 1) {
    const av = Number(a[i] || 0);
    const bv = Number(b[i] || 0);
    dot += av * bv;
    normA += av * av;
    normB += bv * bv;
  }
  if (normA === 0 || normB === 0) {
    return 0;
  }
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

function tokenize(text: unknown): string[] {
  return String(text || "")
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, " ")
    .split(/\s+/)
    .map((t) => t.trim())
    .filter((t) => t.length >= 2);
}

function normalize(vector: number[]): number[] {
  const norm = Math.sqrt(vector.reduce((sum, v) => sum + v * v, 0));
  if (!norm) {
    return vector;
  }
  return vector.map((v) => v / norm);
}

function hash(str: string): number {
  let h = 5381;
  for (let i = 0; i < str.length; i += 1) {
    h = ((h << 5) + h) + str.charCodeAt(i);
    h |= 0;
  }
  return h;
}
