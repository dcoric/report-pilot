const crypto = require("crypto");
const appDb = require("../lib/appDb");
const { embedTextsForIndexing } = require("./embeddingRouter");

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

async function buildRagDocuments(dataSourceId) {
  const [
    schemaObjectsResult,
    columnsResult,
    relationshipsResult,
    semanticEntitiesResult,
    metricDefinitionsResult,
    joinPoliciesResult,
    examplesResult,
    ragNotesResult
  ] = await Promise.all([
    appDb.query(
      `
        SELECT id, object_type, schema_name, object_name, description
        FROM schema_objects
        WHERE data_source_id = $1
        ORDER BY schema_name, object_name
      `,
      [dataSourceId]
    ),
    appDb.query(
      `
        SELECT
          c.id,
          c.schema_object_id,
          c.column_name,
          c.data_type,
          c.nullable,
          c.is_pk
        FROM columns c
        JOIN schema_objects so ON so.id = c.schema_object_id
        WHERE so.data_source_id = $1
        ORDER BY c.schema_object_id, c.ordinal_position
      `,
      [dataSourceId]
    ),
    appDb.query(
      `
        SELECT
          r.id,
          r.from_object_id,
          r.from_column,
          r.to_object_id,
          r.to_column,
          r.relationship_type
        FROM relationships r
        JOIN schema_objects so ON so.id = r.from_object_id
        WHERE so.data_source_id = $1
      `,
      [dataSourceId]
    ),
    appDb.query(
      `
        SELECT id, entity_type, target_ref, business_name, description, owner
        FROM semantic_entities
        WHERE data_source_id = $1 AND active = TRUE
        ORDER BY entity_type, business_name
      `,
      [dataSourceId]
    ),
    appDb.query(
      `
        SELECT md.id, md.semantic_entity_id, md.sql_expression, md.grain, se.business_name
        FROM metric_definitions md
        JOIN semantic_entities se ON se.id = md.semantic_entity_id
        WHERE se.data_source_id = $1 AND se.active = TRUE
        ORDER BY se.business_name
      `,
      [dataSourceId]
    ),
    appDb.query(
      `
        SELECT id, left_ref, right_ref, join_type, on_clause, notes
        FROM join_policies
        WHERE data_source_id = $1 AND approved = TRUE
        ORDER BY left_ref, right_ref
      `,
      [dataSourceId]
    ),
    appDb.query(
      `
        SELECT id, question, sql, quality_score, source
        FROM nl_sql_examples
        WHERE data_source_id = $1
        ORDER BY created_at DESC
        LIMIT 200
      `,
      [dataSourceId]
    ),
    appDb.query(
      `
        SELECT id, title, content
        FROM rag_notes
        WHERE data_source_id = $1 AND active = TRUE
        ORDER BY created_at DESC
      `,
      [dataSourceId]
    )
  ]);

  const columnsByObject = groupBy(columnsResult.rows, (row) => row.schema_object_id);
  const relationshipsByObject = groupBy(relationshipsResult.rows, (row) => row.from_object_id);
  const objectNameById = new Map(
    schemaObjectsResult.rows.map((obj) => [obj.id, `${obj.schema_name}.${obj.object_name}`])
  );

  const docs = [];

  for (const obj of schemaObjectsResult.rows) {
    const columns = columnsByObject.get(obj.id) || [];
    const relationships = relationshipsByObject.get(obj.id) || [];

    const columnLines = columns.map(
      (col) =>
        `column ${col.column_name} ${col.data_type} nullable=${col.nullable} primary_key=${col.is_pk}`
    );
    const relLines = relationships.map((rel) => {
      const toName = objectNameById.get(rel.to_object_id) || rel.to_object_id;
      return `relationship ${rel.from_column} -> ${toName}.${rel.to_column} type=${rel.relationship_type}`;
    });

    docs.push({
      docType: "schema",
      refId: String(obj.id),
      metadata: {
        object_type: obj.object_type,
        schema_name: obj.schema_name,
        object_name: obj.object_name
      },
      content: [
        `schema object ${obj.schema_name}.${obj.object_name} type=${obj.object_type}`,
        obj.description ? `description ${obj.description}` : null,
        columnLines.length > 0 ? columnLines.join("\n") : "no columns listed",
        relLines.length > 0 ? relLines.join("\n") : "no relationships listed"
      ]
        .filter(Boolean)
        .join("\n")
    });
  }

  for (const entity of semanticEntitiesResult.rows) {
    docs.push({
      docType: "semantic",
      refId: String(entity.id),
      metadata: {
        entity_type: entity.entity_type,
        target_ref: entity.target_ref
      },
      content: [
        `semantic ${entity.entity_type} ${entity.business_name}`,
        `target ${entity.target_ref}`,
        entity.description ? `description ${entity.description}` : null,
        entity.owner ? `owner ${entity.owner}` : null
      ]
        .filter(Boolean)
        .join("\n")
    });
  }

  for (const metric of metricDefinitionsResult.rows) {
    docs.push({
      docType: "semantic",
      refId: String(metric.id),
      metadata: {
        semantic_entity_id: metric.semantic_entity_id,
        business_name: metric.business_name
      },
      content: [
        `metric ${metric.business_name}`,
        metric.grain ? `grain ${metric.grain}` : null,
        `sql ${metric.sql_expression}`
      ]
        .filter(Boolean)
        .join("\n")
    });
  }

  for (const joinPolicy of joinPoliciesResult.rows) {
    docs.push({
      docType: "policy",
      refId: String(joinPolicy.id),
      metadata: {
        left_ref: joinPolicy.left_ref,
        right_ref: joinPolicy.right_ref,
        join_type: joinPolicy.join_type
      },
      content: [
        `approved join policy ${joinPolicy.left_ref} ${joinPolicy.join_type} ${joinPolicy.right_ref}`,
        `on ${joinPolicy.on_clause}`,
        joinPolicy.notes ? `notes ${joinPolicy.notes}` : null
      ]
        .filter(Boolean)
        .join("\n")
    });
  }

  for (const example of examplesResult.rows) {
    docs.push({
      docType: "example",
      refId: String(example.id),
      metadata: {
        source: example.source,
        quality_score: example.quality_score
      },
      content: [
        `example question ${example.question}`,
        `example sql ${example.sql}`
      ].join("\n")
    });
  }

  for (const note of ragNotesResult.rows) {
    docs.push({
      docType: "policy",
      refId: String(note.id),
      metadata: {
        source: "rag_note",
        title: note.title
      },
      content: [`note ${note.title}`, note.content].join("\n")
    });
  }

  return docs;
}

function groupBy(rows, keyFn) {
  const map = new Map();
  for (const row of rows) {
    const key = keyFn(row);
    if (!map.has(key)) {
      map.set(key, []);
    }
    map.get(key).push(row);
  }
  return map;
}

function sha256(content) {
  return crypto.createHash("sha256").update(content).digest("hex");
}

module.exports = {
  reindexRagDocuments,
  __private: {
    buildRagDocuments
  }
};
