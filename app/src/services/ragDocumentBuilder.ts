import appDb = require("../lib/appDb");

export interface RagDocument {
  docType: "schema" | "semantic" | "policy" | "example";
  refId: string;
  metadata: Record<string, unknown>;
  content: string;
}

interface SchemaObjectRow {
  id: string;
  object_type: string;
  schema_name: string;
  object_name: string;
  description: string | null;
}

interface ColumnRow {
  id: string;
  schema_object_id: string;
  column_name: string;
  data_type: string;
  nullable: boolean;
  is_pk: boolean;
}

interface RelationshipRow {
  id: string;
  from_object_id: string;
  from_column: string;
  to_object_id: string;
  to_column: string;
  relationship_type: string;
}

interface SemanticEntityRow {
  id: string;
  entity_type: string;
  target_ref: string;
  business_name: string;
  description: string | null;
  owner: string | null;
}

interface MetricDefinitionRow {
  id: string;
  semantic_entity_id: string;
  sql_expression: string;
  grain: string | null;
  business_name: string;
}

interface JoinPolicyRow {
  id: string;
  left_ref: string;
  right_ref: string;
  join_type: string;
  on_clause: string;
  notes: string | null;
}

interface NlSqlExampleRow {
  id: string;
  question: string;
  sql: string;
  quality_score: number | null;
  source: string | null;
}

interface RagNoteRow {
  id: string;
  title: string;
  content: string;
}

export async function buildRagDocuments(dataSourceId: string): Promise<RagDocument[]> {
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
    appDb.query<SchemaObjectRow>(
      `
        SELECT id, object_type, schema_name, object_name, description
        FROM schema_objects
        WHERE data_source_id = $1
          AND is_ignored = FALSE
        ORDER BY schema_name, object_name
      `,
      [dataSourceId]
    ),
    appDb.query<ColumnRow>(
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
          AND so.is_ignored = FALSE
        ORDER BY c.schema_object_id, c.ordinal_position
      `,
      [dataSourceId]
    ),
    appDb.query<RelationshipRow>(
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
        JOIN schema_objects sto ON sto.id = r.to_object_id
        WHERE so.data_source_id = $1
          AND so.is_ignored = FALSE
          AND sto.is_ignored = FALSE
      `,
      [dataSourceId]
    ),
    appDb.query<SemanticEntityRow>(
      `
        SELECT id, entity_type, target_ref, business_name, description, owner
        FROM semantic_entities
        WHERE data_source_id = $1 AND active = TRUE
        ORDER BY entity_type, business_name
      `,
      [dataSourceId]
    ),
    appDb.query<MetricDefinitionRow>(
      `
        SELECT md.id, md.semantic_entity_id, md.sql_expression, md.grain, se.business_name
        FROM metric_definitions md
        JOIN semantic_entities se ON se.id = md.semantic_entity_id
        WHERE se.data_source_id = $1 AND se.active = TRUE
        ORDER BY se.business_name
      `,
      [dataSourceId]
    ),
    appDb.query<JoinPolicyRow>(
      `
        SELECT id, left_ref, right_ref, join_type, on_clause, notes
        FROM join_policies
        WHERE data_source_id = $1 AND approved = TRUE
        ORDER BY left_ref, right_ref
      `,
      [dataSourceId]
    ),
    appDb.query<NlSqlExampleRow>(
      `
        SELECT id, question, sql, quality_score, source
        FROM nl_sql_examples
        WHERE data_source_id = $1
        ORDER BY created_at DESC
        LIMIT 200
      `,
      [dataSourceId]
    ),
    appDb.query<RagNoteRow>(
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

  const docs: RagDocument[] = [];

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

function groupBy<T>(rows: T[], keyFn: (row: T) => string): Map<string, T[]> {
  const map = new Map<string, T[]>();
  for (const row of rows) {
    const key = keyFn(row);
    if (!map.has(key)) {
      map.set(key, []);
    }
    map.get(key)!.push(row);
  }
  return map;
}
