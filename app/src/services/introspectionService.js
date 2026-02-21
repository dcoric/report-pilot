const crypto = require("crypto");
const { createDatabaseAdapter } = require("../adapters/dbAdapterFactory");
const appDb = require("../lib/appDb");

async function runIntrospection(dataSource) {
  const adapter = createDatabaseAdapter(dataSource.db_type, dataSource.connection_ref);
  try {
    const snapshot = await adapter.introspectSchema();
    await persistSnapshot(dataSource.id, snapshot);
    return snapshot;
  } finally {
    await adapter.close();
  }
}

async function persistSnapshot(dataSourceId, snapshot) {
  await appDb.withTransaction(async (client) => {
    await client.query("DELETE FROM schema_objects WHERE data_source_id = $1", [dataSourceId]);

    const objectIdByKey = new Map();

    for (const object of snapshot.objects) {
      const hash = computeObjectHash(object, snapshot.columns, snapshot.relationships);
      const objectInsert = await client.query(
        `
          INSERT INTO schema_objects (
            data_source_id,
            object_type,
            schema_name,
            object_name,
            hash,
            last_seen_at
          ) VALUES ($1, $2, $3, $4, $5, NOW())
          RETURNING id
        `,
        [dataSourceId, object.objectType, object.schemaName, object.objectName, hash]
      );

      const objectId = objectInsert.rows[0].id;
      objectIdByKey.set(objectKey(object.schemaName, object.objectName), objectId);
    }

    for (const column of snapshot.columns) {
      const schemaObjectId = objectIdByKey.get(objectKey(column.schemaName, column.objectName));
      if (!schemaObjectId) {
        continue;
      }

      await client.query(
        `
          INSERT INTO columns (
            schema_object_id,
            column_name,
            data_type,
            nullable,
            is_pk,
            ordinal_position
          ) VALUES ($1, $2, $3, $4, $5, $6)
        `,
        [
          schemaObjectId,
          column.columnName,
          column.dataType,
          column.nullable,
          column.isPk,
          column.ordinalPosition
        ]
      );
    }

    for (const relationship of snapshot.relationships) {
      const fromId = objectIdByKey.get(objectKey(relationship.fromSchema, relationship.fromObject));
      const toId = objectIdByKey.get(objectKey(relationship.toSchema, relationship.toObject));
      if (!fromId || !toId) {
        continue;
      }

      await client.query(
        `
          INSERT INTO relationships (
            from_object_id,
            from_column,
            to_object_id,
            to_column,
            relationship_type
          ) VALUES ($1, $2, $3, $4, $5)
        `,
        [fromId, relationship.fromColumn, toId, relationship.toColumn, relationship.relationshipType]
      );
    }

    for (const idx of snapshot.indexes) {
      const schemaObjectId = objectIdByKey.get(objectKey(idx.schemaName, idx.objectName));
      if (!schemaObjectId) {
        continue;
      }

      await client.query(
        `
          INSERT INTO indexes (
            schema_object_id,
            index_name,
            columns,
            is_unique
          ) VALUES ($1, $2, $3, $4)
        `,
        [schemaObjectId, idx.indexName, idx.columns, idx.isUnique]
      );
    }
  });
}

function objectKey(schemaName, objectName) {
  return `${schemaName}.${objectName}`.toLowerCase();
}

function computeObjectHash(object, allColumns, allRelationships) {
  const columns = allColumns
    .filter((column) => column.schemaName === object.schemaName && column.objectName === object.objectName)
    .map((column) => `${column.columnName}:${column.dataType}:${column.nullable}:${column.isPk}`)
    .sort();

  const relationships = allRelationships
    .filter(
      (rel) =>
        rel.fromSchema === object.schemaName &&
        rel.fromObject === object.objectName
    )
    .map((rel) => `${rel.fromColumn}->${rel.toSchema}.${rel.toObject}.${rel.toColumn}`)
    .sort();

  return crypto
    .createHash("sha256")
    .update(JSON.stringify({ object, columns, relationships }))
    .digest("hex");
}

module.exports = {
  runIntrospection
};
