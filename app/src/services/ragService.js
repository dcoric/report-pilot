const crypto = require("crypto");
const appDb = require("../lib/appDb");
const { embedTextsForIndexing } = require("./embeddingRouter");
const { buildRagDocuments } = require("./ragDocumentBuilder");

async function reindexRagDocuments(dataSourceId) {
  const docs = await buildRagDocuments(dataSourceId);
  const embedResponse = await embedTextsForIndexing(docs.map((doc) => doc.content));
  const vectors = embedResponse.vectors || [];
  const embeddingModel = embedResponse.embeddingModel;

  await appDb.withTransaction(async (client) => {
    await client.query("DELETE FROM rag_documents WHERE data_source_id = $1", [dataSourceId]);

    for (let idx = 0; idx < docs.length; idx += 1) {
      const doc = docs[idx];
      const contentHash = sha256(doc.content);
      const insertResult = await client.query(
        `
          INSERT INTO rag_documents (
            data_source_id,
            doc_type,
            ref_id,
            content,
            metadata_json,
            content_hash
          ) VALUES ($1, $2, $3, $4, $5, $6)
          RETURNING id
        `,
        [dataSourceId, doc.docType, doc.refId, doc.content, JSON.stringify(doc.metadata || {}), contentHash]
      );

      const ragDocumentId = insertResult.rows[0].id;
      const vector = vectors[idx] || [];
      await client.query(
        `
          INSERT INTO rag_embeddings (
            rag_document_id,
            embedding_model,
            vector_json,
            chunk_idx
          ) VALUES ($1, $2, $3, 0)
        `,
        [ragDocumentId, embeddingModel, JSON.stringify(vector)]
      );
    }
  });

  return {
    data_source_id: dataSourceId,
    documents_indexed: docs.length,
    embedding_model: embeddingModel
  };
}

function triggerRagReindexAsync(dataSourceId) {
  if (!dataSourceId) {
    return;
  }

  setImmediate(() => {
    module.exports.reindexRagDocuments(dataSourceId).catch((err) => {
      console.error(`[rag] reindex failed for ${dataSourceId}: ${err.message}`);
    });
  });
}

function sha256(content) {
  return crypto.createHash("sha256").update(content).digest("hex");
}

module.exports = {
  reindexRagDocuments,
  triggerRagReindexAsync,
  __private: {
    buildRagDocuments
  }
};
