const appDb = require("../lib/appDb");
const { json, badRequest, readJsonBody } = require("../lib/http");
const { logEvent } = require("../lib/observability");
const { isUuid, groupByKey, validateDataSourceImportPayload } = require("../lib/validation");
const { isSupportedDbType } = require("../adapters/dbAdapterFactory");
const { reindexRagDocuments } = require("../services/ragService");
const { enforceDataSourceAccess } = require("../lib/authGate");

async function handleExportDataSource(req, res, dataSourceId) {
  if (!isUuid(dataSourceId)) {
    return badRequest(res, "dataSourceId must be a valid UUID");
  }

  const dsResult = await appDb.query(
    "SELECT id, name, db_type, connection_ref FROM data_sources WHERE id = $1",
    [dataSourceId]
  );
  if (dsResult.rowCount === 0) {
    return json(res, 404, { error: "not_found", message: "Data source not found" });
  }
  if (!(await enforceDataSourceAccess(req, res, dataSourceId))) {
    return undefined;
  }
  const ds = dsResult.rows[0];

  const [
    schemaObjectsResult,
    ragNotesResult,
    semanticEntitiesResult,
    joinPoliciesResult,
    examplesResult,
    synonymsResult
  ] = await Promise.all([
    appDb.query(
      `SELECT id, object_type, schema_name, object_name, description, is_ignored
       FROM schema_objects WHERE data_source_id = $1
       ORDER BY schema_name, object_name`,
      [dataSourceId]
    ),
    appDb.query(
      `SELECT title, content, active
       FROM rag_notes WHERE data_source_id = $1
       ORDER BY created_at`,
      [dataSourceId]
    ),
    appDb.query(
      `SELECT id, entity_type, target_ref, business_name, description, owner, active
       FROM semantic_entities WHERE data_source_id = $1
       ORDER BY entity_type, business_name`,
      [dataSourceId]
    ),
    appDb.query(
      `SELECT left_ref, right_ref, join_type, on_clause, approved, notes
       FROM join_policies WHERE data_source_id = $1
       ORDER BY left_ref, right_ref`,
      [dataSourceId]
    ),
    appDb.query(
      `SELECT question, sql, quality_score, source
       FROM nl_sql_examples WHERE data_source_id = $1
       ORDER BY created_at`,
      [dataSourceId]
    ),
    appDb.query(
      `SELECT term, maps_to_ref, weight
       FROM synonyms WHERE data_source_id = $1
       ORDER BY term`,
      [dataSourceId]
    )
  ]);

  const objectIds = schemaObjectsResult.rows.map((o) => o.id);

  let columnsResult = { rows: [] };
  let relationshipsResult = { rows: [] };
  let indexesResult = { rows: [] };

  if (objectIds.length > 0) {
    [columnsResult, relationshipsResult, indexesResult] = await Promise.all([
      appDb.query(
        `SELECT schema_object_id, column_name, data_type, nullable, is_pk, ordinal_position
         FROM columns
         WHERE schema_object_id = ANY($1)
         ORDER BY schema_object_id, ordinal_position`,
        [objectIds]
      ),
      appDb.query(
        `SELECT from_object_id, from_column, to_object_id, to_column, relationship_type
         FROM relationships
         WHERE from_object_id = ANY($1)`,
        [objectIds]
      ),
      appDb.query(
        `SELECT schema_object_id, index_name, columns, is_unique
         FROM indexes
         WHERE schema_object_id = ANY($1)
         ORDER BY schema_object_id, index_name`,
        [objectIds]
      )
    ]);
  }

  const seIds = semanticEntitiesResult.rows.map((se) => se.id);
  let metricDefsResult = { rows: [] };
  if (seIds.length > 0) {
    metricDefsResult = await appDb.query(
      `SELECT semantic_entity_id, sql_expression, grain, filters_json
       FROM metric_definitions WHERE semantic_entity_id = ANY($1)`,
      [seIds]
    );
  }

  const objectById = new Map(schemaObjectsResult.rows.map((o) => [o.id, o]));
  const columnsByObj = groupByKey(columnsResult.rows, "schema_object_id");
  const relsByObj = groupByKey(relationshipsResult.rows, "from_object_id");
  const idxByObj = groupByKey(indexesResult.rows, "schema_object_id");
  const metricsBySe = groupByKey(metricDefsResult.rows, "semantic_entity_id");

  const schemaObjects = schemaObjectsResult.rows.map((obj) => ({
    object_type: obj.object_type,
    schema_name: obj.schema_name,
    object_name: obj.object_name,
    description: obj.description,
    is_ignored: obj.is_ignored,
    columns: (columnsByObj[obj.id] || []).map((c) => ({
      column_name: c.column_name,
      data_type: c.data_type,
      nullable: c.nullable,
      is_pk: c.is_pk,
      ordinal_position: c.ordinal_position
    })),
    relationships: (relsByObj[obj.id] || []).map((r) => {
      const toObj = objectById.get(r.to_object_id);
      return {
        from_column: r.from_column,
        to_schema: toObj ? toObj.schema_name : null,
        to_object: toObj ? toObj.object_name : null,
        to_column: r.to_column,
        relationship_type: r.relationship_type
      };
    }),
    indexes: (idxByObj[obj.id] || []).map((i) => ({
      index_name: i.index_name,
      columns: i.columns,
      is_unique: i.is_unique
    }))
  }));

  const semanticEntities = semanticEntitiesResult.rows.map((se) => ({
    entity_type: se.entity_type,
    target_ref: se.target_ref,
    business_name: se.business_name,
    description: se.description,
    owner: se.owner,
    active: se.active,
    metric_definitions: (metricsBySe[se.id] || []).map((md) => ({
      sql_expression: md.sql_expression,
      grain: md.grain,
      filters_json: md.filters_json
    }))
  }));

  const payload = {
    version: 1,
    exported_at: new Date().toISOString(),
    data_source: {
      name: ds.name,
      db_type: ds.db_type,
      connection_ref: ds.connection_ref
    },
    schema_objects: schemaObjects,
    rag_notes: ragNotesResult.rows.map((n) => ({
      title: n.title,
      content: n.content,
      active: n.active
    })),
    semantic_entities: semanticEntities,
    join_policies: joinPoliciesResult.rows,
    nl_sql_examples: examplesResult.rows,
    synonyms: synonymsResult.rows
  };

  const filename = `${ds.name.replace(/[^a-zA-Z0-9_-]/g, "_")}_export.json`;
  res.writeHead(200, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Disposition": `attachment; filename="${filename}"`
  });
  return res.end(JSON.stringify(payload, null, 2));
}

async function handleImportDataSource(req, res) {
  const body = await readJsonBody(req);

  const validationError = validateDataSourceImportPayload(body);
  if (validationError) {
    return badRequest(res, validationError);
  }

  const ds = body.data_source;
  const normalizedDbType = String(ds.db_type).trim().toLowerCase();
  if (!isSupportedDbType(normalizedDbType)) {
    return badRequest(res, "Unsupported db_type. Supported values: postgres, mssql");
  }

  const dataSourceId = await appDb.withTransaction(async (client) => {
    const dsInsert = await client.query(
      `INSERT INTO data_sources (name, db_type, connection_ref, status)
       VALUES ($1, $2, $3, 'active')
       RETURNING id`,
      [ds.name, normalizedDbType, ds.connection_ref]
    );
    const newDsId = dsInsert.rows[0].id;

    const objectIdByKey = new Map();
    for (const obj of (body.schema_objects || [])) {
      const objInsert = await client.query(
        `INSERT INTO schema_objects (data_source_id, object_type, schema_name, object_name, description, is_ignored, hash, last_seen_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())
         RETURNING id`,
        [newDsId, obj.object_type, obj.schema_name, obj.object_name, obj.description || null, obj.is_ignored === true, "imported"]
      );
      const objId = objInsert.rows[0].id;
      objectIdByKey.set(`${obj.schema_name}.${obj.object_name}`.toLowerCase(), objId);

      for (const col of (obj.columns || [])) {
        await client.query(
          `INSERT INTO columns (schema_object_id, column_name, data_type, nullable, is_pk, ordinal_position)
           VALUES ($1, $2, $3, $4, $5, $6)`,
          [objId, col.column_name, col.data_type, col.nullable, col.is_pk, col.ordinal_position]
        );
      }

      for (const idx of (obj.indexes || [])) {
        await client.query(
          `INSERT INTO indexes (schema_object_id, index_name, columns, is_unique)
           VALUES ($1, $2, $3, $4)`,
          [objId, idx.index_name, idx.columns, idx.is_unique]
        );
      }
    }

    for (const obj of (body.schema_objects || [])) {
      const fromKey = `${obj.schema_name}.${obj.object_name}`.toLowerCase();
      const fromId = objectIdByKey.get(fromKey);
      if (!fromId) continue;

      for (const rel of (obj.relationships || [])) {
        const toKey = `${rel.to_schema}.${rel.to_object}`.toLowerCase();
        const toId = objectIdByKey.get(toKey);
        if (!toId) continue;

        await client.query(
          `INSERT INTO relationships (from_object_id, from_column, to_object_id, to_column, relationship_type)
           VALUES ($1, $2, $3, $4, $5)`,
          [fromId, rel.from_column, toId, rel.to_column, rel.relationship_type]
        );
      }
    }

    for (const note of (body.rag_notes || [])) {
      await client.query(
        `INSERT INTO rag_notes (data_source_id, title, content, active, created_by, updated_by)
         VALUES ($1, $2, $3, $4, 'import', 'import')`,
        [newDsId, note.title, note.content, note.active !== false]
      );
    }

    for (const se of (body.semantic_entities || [])) {
      const seInsert = await client.query(
        `INSERT INTO semantic_entities (data_source_id, entity_type, target_ref, business_name, description, owner, active)
         VALUES ($1, $2, $3, $4, $5, $6, COALESCE($7, TRUE))
         RETURNING id`,
        [newDsId, se.entity_type, se.target_ref, se.business_name, se.description || null, se.owner || null, se.active]
      );
      const seId = seInsert.rows[0].id;

      for (const md of (se.metric_definitions || [])) {
        await client.query(
          `INSERT INTO metric_definitions (semantic_entity_id, sql_expression, grain, filters_json)
           VALUES ($1, $2, $3, $4)`,
          [seId, md.sql_expression, md.grain || null, md.filters_json || null]
        );
      }
    }

    for (const jp of (body.join_policies || [])) {
      await client.query(
        `INSERT INTO join_policies (data_source_id, left_ref, right_ref, join_type, on_clause, approved, notes)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [newDsId, jp.left_ref, jp.right_ref, jp.join_type, jp.on_clause, jp.approved !== false, jp.notes || null]
      );
    }

    for (const ex of (body.nl_sql_examples || [])) {
      await client.query(
        `INSERT INTO nl_sql_examples (data_source_id, question, sql, quality_score, source)
         VALUES ($1, $2, $3, $4, $5)`,
        [newDsId, ex.question, ex.sql, ex.quality_score || null, ex.source || "manual"]
      );
    }

    for (const syn of (body.synonyms || [])) {
      await client.query(
        `INSERT INTO synonyms (data_source_id, term, maps_to_ref, weight)
         VALUES ($1, $2, $3, $4)`,
        [newDsId, syn.term, syn.maps_to_ref, syn.weight || 1.0]
      );
    }

    return newDsId;
  });

  try {
    await reindexRagDocuments(dataSourceId);
  } catch (err) {
    logEvent("data_source_import_reindex_failed", { data_source_id: dataSourceId, error: err.message }, "error");
    return json(res, 500, {
      error: "internal_error",
      message: `Data source was imported but RAG reindex failed: ${err.message}`,
      data_source_id: dataSourceId
    });
  }

  return json(res, 201, { ok: true, data_source_id: dataSourceId });
}

module.exports = {
  handleExportDataSource,
  handleImportDataSource
};
