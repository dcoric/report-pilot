const appDb = require("../lib/appDb");
const { LOCAL_EMBEDDING_MODEL, embedQueryForModel } = require("./embeddingRouter");
const { cosineSimilarity } = require("./localEmbedding");

async function retrieveRagContext(dataSourceId, question, opts = {}) {
  const limit = Number(opts.limit || 12);
  const q = String(question || "").trim();

  if (!q) {
    return [];
  }

  const embeddingModel = await selectEmbeddingModel(dataSourceId);
  const result = await appDb.query(
    `
      SELECT
        rd.id,
        rd.doc_type,
        rd.ref_id,
        rd.content,
        rd.metadata_json,
        re.vector_json
      FROM rag_documents rd
      LEFT JOIN rag_embeddings re
        ON re.rag_document_id = rd.id
       AND re.embedding_model = $2
      WHERE rd.data_source_id = $1
      ORDER BY rd.created_at DESC
      LIMIT 400
    `,
    [dataSourceId, embeddingModel]
  );

  const tokens = tokenize(q);
  const qVector = await embedQueryForModel(q, embeddingModel);
  const ranked = result.rows
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
  const fill = result.rows
    .filter((row) => !usedIds.has(row.id))
    .slice(0, Math.max(0, limit - reranked.length))
    .map((row) => ({ ...row, score: 0, embedding_model: embeddingModel, rerank_score: 0 }));

  return reranked.concat(fill);
}

async function selectEmbeddingModel(dataSourceId) {
  const result = await appDb.query(
    `
      SELECT re.embedding_model, COUNT(*) AS doc_count
      FROM rag_embeddings re
      JOIN rag_documents rd ON rd.id = re.rag_document_id
      WHERE rd.data_source_id = $1
      GROUP BY re.embedding_model
      ORDER BY doc_count DESC
      LIMIT 1
    `,
    [dataSourceId]
  );

  return result.rows[0]?.embedding_model || LOCAL_EMBEDDING_MODEL;
}

function tokenize(text) {
  return String(text || "")
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, " ")
    .split(/\s+/)
    .map((t) => t.trim())
    .filter((t) => t.length >= 2);
}

function computeHybridScore(question, tokens, qVector, content, vectorJson) {
  const lexical = computeLexicalScore(question, tokens, content);
  const vector = computeVectorScore(qVector, vectorJson);
  return Number((lexical + (vector * 2)).toFixed(4));
}

function rerankDocuments(question, tokens, rows) {
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
    .sort((a, b) => b.rerank_score - a.rerank_score);
}

function tokenCoverage(tokens, content) {
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

function docTypeBoost(docType) {
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

function computeLexicalScore(question, tokens, content) {
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

function computeVectorScore(queryVector, vectorJson) {
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

module.exports = {
  retrieveRagContext
};
