import appDb = require("../lib/appDb");
import { LOCAL_EMBEDDING_MODEL, embedQueryForModel } from "./embeddingRouter";
import { cosineSimilarity } from "./localEmbedding";

export interface RagRetrievalDoc {
  id: string;
  doc_type: string;
  ref_id: string;
  content: string;
  metadata_json: Record<string, unknown> | null;
  vector_json: number[] | null;
  score: number;
  embedding_model: string;
  rerank_score?: number;
}

export interface RetrieveRagContextOptions {
  limit?: number;
  docTypes?: Array<"schema" | "semantic" | "example" | "policy">;
  candidateLimit?: number;
  fallbackLimit?: number;
}

export async function retrieveRagContext(
  dataSourceId: string,
  question: string,
  opts: RetrieveRagContextOptions = {}
): Promise<RagRetrievalDoc[]> {
  const limit = Number(opts.limit || 12);
  const candidateLimit = positiveInteger(opts.candidateLimit, Math.max(64, limit * 8), 200);
  const fallbackLimit = positiveInteger(opts.fallbackLimit, Math.max(16, limit * 2), 64);
  const docTypes = normalizeDocTypes(opts.docTypes);
  const q = String(question || "").trim();

  if (!q) {
    return [];
  }

  const embeddingModel = await selectEmbeddingModel(dataSourceId);
  const result = await appDb.query<{
    id: string;
    doc_type: string;
    ref_id: string;
    content: string;
    metadata_json: Record<string, unknown> | null;
    vector_json: number[] | null;
  }>(
    `
      WITH current_index AS (
        SELECT schema_version
        FROM rag_index_state
        WHERE data_source_id = $1
      ),
      query_terms AS (
        SELECT websearch_to_tsquery('simple', $3) AS query
      ),
      lexical_candidates AS (
        SELECT
          rd.id,
          ts_rank_cd(rd.search_vector, qt.query) AS lexical_rank
        FROM rag_documents rd
        JOIN current_index ci ON ci.schema_version = rd.schema_version
        CROSS JOIN query_terms qt
        WHERE rd.data_source_id = $1
          AND ($4::text[] IS NULL OR rd.doc_type = ANY($4::text[]))
          AND rd.search_vector @@ qt.query
        ORDER BY lexical_rank DESC, rd.created_at DESC
        LIMIT $5
      ),
      fallback_candidates AS (
        SELECT rd.id, 0::real AS lexical_rank
        FROM rag_documents rd
        JOIN current_index ci ON ci.schema_version = rd.schema_version
        WHERE rd.data_source_id = $1
          AND ($4::text[] IS NULL OR rd.doc_type = ANY($4::text[]))
        ORDER BY rd.created_at DESC
        LIMIT $6
      ),
      candidates AS (
        SELECT id, MAX(lexical_rank) AS lexical_rank
        FROM (
          SELECT * FROM lexical_candidates
          UNION ALL
          SELECT * FROM fallback_candidates
        ) candidate_pool
        GROUP BY id
      )
      SELECT
        rd.id,
        rd.doc_type,
        rd.ref_id,
        rd.content,
        rd.metadata_json,
        re.vector_json
      FROM candidates candidate
      JOIN rag_documents rd ON rd.id = candidate.id
      LEFT JOIN rag_embeddings re
        ON re.rag_document_id = rd.id
       AND re.embedding_model = $2
      ORDER BY candidate.lexical_rank DESC, rd.created_at DESC
      LIMIT $7
    `,
    [dataSourceId, embeddingModel, q, docTypes, candidateLimit, fallbackLimit, candidateLimit + fallbackLimit]
  );

  const tokens = tokenize(q);
  const qVector = await embedQueryForModel(q, embeddingModel);
  const ranked: RagRetrievalDoc[] = result.rows
    .map((row) => ({
      ...row,
      score: computeHybridScore(q, tokens, qVector, row.content, row.vector_json),
      embedding_model: embeddingModel
    }))
    .filter((row) => row.score > 0);

  const reranked = rerankDocuments(q, tokens, ranked);

  if (reranked.length >= limit) {
    return reranked.slice(0, limit);
  }

  const usedIds = new Set(reranked.map((row) => row.id));
  const fill: RagRetrievalDoc[] = result.rows
    .filter((row) => !usedIds.has(row.id))
    .slice(0, Math.max(0, limit - reranked.length))
    .map((row) => ({ ...row, score: 0, embedding_model: embeddingModel, rerank_score: 0 }));

  return reranked.concat(fill);
}

async function selectEmbeddingModel(dataSourceId: string): Promise<string> {
  const result = await appDb.query<{ embedding_model: string; doc_count: number | string }>(
    `
      SELECT re.embedding_model, COUNT(*) AS doc_count
      FROM rag_embeddings re
      JOIN rag_documents rd ON rd.id = re.rag_document_id
      WHERE rd.data_source_id = $1
        AND rd.schema_version = (
          SELECT schema_version FROM rag_index_state WHERE data_source_id = $1
        )
      GROUP BY re.embedding_model
      ORDER BY doc_count DESC
      LIMIT 1
    `,
    [dataSourceId]
  );

  return result.rows[0]?.embedding_model || LOCAL_EMBEDDING_MODEL;
}

function normalizeDocTypes(value: RetrieveRagContextOptions["docTypes"]): string[] | null {
  if (!Array.isArray(value) || value.length === 0) return null;
  return [...new Set(value)];
}

function positiveInteger(value: unknown, fallback: number, max: number): number {
  const number = Number(value);
  if (!Number.isInteger(number) || number <= 0) return Math.min(fallback, max);
  return Math.min(number, max);
}

function tokenize(text: unknown): string[] {
  return String(text || "")
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, " ")
    .split(/\s+/)
    .map((t) => t.trim())
    .filter((t) => t.length >= 2);
}

function computeHybridScore(
  question: string,
  tokens: string[],
  qVector: number[] | null,
  content: string,
  vectorJson: number[] | null
): number {
  const lexical = computeLexicalScore(question, tokens, content);
  const vector = computeVectorScore(qVector, vectorJson);
  return Number((lexical + (vector * 2)).toFixed(4));
}

function rerankDocuments(question: string, tokens: string[], rows: RagRetrievalDoc[]): RagRetrievalDoc[] {
  const q = String(question || "").toLowerCase();
  return rows
    .map((row) => {
      const content = String(row.content || "").toLowerCase();
      const coverage = tokenCoverage(tokens, content);
      const typeBoost = docTypeBoost(row.doc_type);
      const exactBoost = q && content.includes(q) ? 1.0 : 0;
      const rerankScore = Number((row.score + (coverage * 1.5) + typeBoost + exactBoost).toFixed(4));
      return {
        ...row,
        rerank_score: rerankScore
      };
    })
    .sort((a, b) => (b.rerank_score || 0) - (a.rerank_score || 0));
}

function tokenCoverage(tokens: string[], content: string): number {
  if (!tokens || tokens.length === 0) {
    return 0;
  }
  const set = new Set(tokens);
  let hits = 0;
  for (const token of set) {
    if (content.includes(token)) {
      hits += 1;
    }
  }
  return hits / set.size;
}

function docTypeBoost(docType: string): number {
  if (docType === "semantic") {
    return 0.9;
  }
  if (docType === "example") {
    return 0.8;
  }
  if (docType === "policy") {
    return 0.5;
  }
  return 0.2;
}

function computeLexicalScore(question: string, tokens: string[], content: string): number {
  const haystack = String(content || "").toLowerCase();
  if (!haystack) {
    return 0;
  }

  let score = 0;
  const normalizedQuestion = String(question || "").toLowerCase();
  if (normalizedQuestion && haystack.includes(normalizedQuestion)) {
    score += 3;
  }

  const uniqueTokens = new Set(tokens);
  for (const token of uniqueTokens) {
    if (haystack.includes(token)) {
      score += 1;
    }
  }

  return score;
}

function computeVectorScore(queryVector: number[] | null, vectorJson: number[] | null): number {
  if (!Array.isArray(queryVector) || queryVector.length === 0) {
    return 0;
  }
  const docVector = Array.isArray(vectorJson) ? vectorJson : null;
  if (!docVector || docVector.length === 0) {
    return 0;
  }
  const cosine = cosineSimilarity(queryVector, docVector);
  if (!Number.isFinite(cosine) || cosine <= 0) {
    return 0;
  }
  return cosine;
}
