import { createHash } from "crypto";
import type { PoolClient } from "pg";
import appDb = require("../lib/appDb");
import { embedTextsForIndexing } from "./embeddingRouter";
import { buildRagDocuments } from "./ragDocumentBuilder";
import { invalidateSchemaArtifacts } from "./schemaArtifactCache";
import { bindTelemetryContext, withTelemetrySpan } from "../lib/telemetry";

interface ReindexResult {
  data_source_id: string;
  documents_indexed: number;
  embedding_model: string;
  schema_version: number;
}

async function reindexRagDocuments(dataSourceId: string): Promise<ReindexResult> {
  invalidateSchemaArtifacts(dataSourceId);
  const docs = await buildRagDocuments(dataSourceId);
  const embedResponse = await embedTextsForIndexing(docs.map((doc) => doc.content));
  const vectors = embedResponse.vectors || [];
  const embeddingModel = embedResponse.embeddingModel;

  const schemaVersion = await appDb.withTransaction(async (client: PoolClient) => {
    const nextVersion = await advanceRagSchemaVersion(client, dataSourceId);
    await client.query("DELETE FROM rag_documents WHERE data_source_id = $1", [dataSourceId]);

    for (let idx = 0; idx < docs.length; idx += 1) {
      const doc = docs[idx];
      const contentHash = sha256(doc.content);
      const insertResult = await client.query<{ id: string }>(
        `
          INSERT INTO rag_documents (
            data_source_id,
            doc_type,
            ref_id,
            content,
            metadata_json,
            content_hash,
            schema_version
          ) VALUES ($1, $2, $3, $4, $5, $6, $7)
          RETURNING id
        `,
        [dataSourceId, doc.docType, doc.refId, doc.content, JSON.stringify(doc.metadata || {}), contentHash, nextVersion]
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
    return nextVersion;
  });

  return {
    data_source_id: dataSourceId,
    documents_indexed: docs.length,
    embedding_model: embeddingModel,
    schema_version: schemaVersion
  };
}

async function advanceRagSchemaVersion(client: PoolClient, dataSourceId: string): Promise<number> {
  const versionResult = await client.query<{ schema_version: number | string }>(
    `
      INSERT INTO rag_index_state (data_source_id, schema_version, updated_at)
      VALUES ($1, 1, NOW())
      ON CONFLICT (data_source_id) DO UPDATE
        SET schema_version = rag_index_state.schema_version + 1,
            updated_at = NOW()
      RETURNING schema_version
    `,
    [dataSourceId]
  );
  return Number(versionResult.rows[0].schema_version);
}

function triggerRagReindexAsync(dataSourceId: string | null | undefined): void {
  if (!dataSourceId) {
    return;
  }

  invalidateSchemaArtifacts(dataSourceId);

  setImmediate(bindTelemetryContext(() => {
    // Read through the export object so test monkey-patches of
    // ragService.reindexRagDocuments are honored.
    withTelemetrySpan("background.rag.reindex", {
      "pipeline.stage": "rag_reindex"
    }, () => moduleExports.reindexRagDocuments(dataSourceId)).catch((err: Error) => {
      console.error(`[rag] reindex failed for ${dataSourceId}: ${err.message}`);
    });
  }));
}

function sha256(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

// Use `export = { ... }` so `app/test/ragNotesApi.test.js` can monkey-patch
// `ragService.reindexRagDocuments`. Named `export` statements compile to
// immutable getters under tsx/esbuild (see lib/appDb.ts for the same gotcha).
//
// `triggerRagReindexAsync` reads through this object so monkey-patches at
// test time (after the module is loaded) are honored. Using `exports`
// directly would point to the original (empty) module export object
// because `export = { ... }` reassigns `module.exports` to a new object.
const moduleExports = {
  reindexRagDocuments,
  triggerRagReindexAsync,
  __private: {
    buildRagDocuments,
    advanceRagSchemaVersion
  }
};
export = moduleExports;
