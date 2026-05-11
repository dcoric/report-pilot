const appDb = require("../lib/appDb");
const { json, badRequest, readJsonBody } = require("../lib/http");
const { ENTITY_TYPES } = require("../lib/constants");
const { triggerRagReindexAsync } = require("../services/ragService");
const { enforceDataSourceAccess } = require("../lib/authGate");

async function handleUpsertSemanticEntity(req, res) {
  const body = await readJsonBody(req);
  const {
    id,
    data_source_id: dataSourceId,
    entity_type: entityType,
    target_ref: targetRef,
    business_name: businessName,
    description,
    owner,
    active
  } = body;

  if (!dataSourceId || !entityType || !targetRef || !businessName) {
    return badRequest(res, "data_source_id, entity_type, target_ref and business_name are required");
  }

  if (!ENTITY_TYPES.has(entityType)) {
    return badRequest(res, "Invalid entity_type");
  }

  if (!(await enforceDataSourceAccess(req, res, dataSourceId))) {
    return undefined;
  }

  if (id) {
    const updateResult = await appDb.query(
      `
        UPDATE semantic_entities
        SET
          data_source_id = $2,
          entity_type = $3,
          target_ref = $4,
          business_name = $5,
          description = $6,
          owner = $7,
          active = COALESCE($8, active)
        WHERE id = $1
        RETURNING id, active
      `,
      [id, dataSourceId, entityType, targetRef, businessName, description || null, owner || null, active]
    );

    if (updateResult.rowCount === 0) {
      return json(res, 404, { error: "not_found", message: "Semantic entity not found" });
    }
    triggerRagReindexAsync(dataSourceId);
    return json(res, 200, updateResult.rows[0]);
  }

  const insertResult = await appDb.query(
    `
      INSERT INTO semantic_entities (
        data_source_id,
        entity_type,
        target_ref,
        business_name,
        description,
        owner,
        active
      ) VALUES ($1, $2, $3, $4, $5, $6, COALESCE($7, TRUE))
      RETURNING id, active
    `,
    [dataSourceId, entityType, targetRef, businessName, description || null, owner || null, active]
  );

  triggerRagReindexAsync(dataSourceId);
  return json(res, 200, insertResult.rows[0]);
}

async function handleUpsertMetricDefinition(req, res) {
  const body = await readJsonBody(req);
  const { id, semantic_entity_id: semanticEntityId, sql_expression: sqlExpression, grain, filters_json: filtersJson } = body;

  if (!semanticEntityId || !sqlExpression) {
    return badRequest(res, "semantic_entity_id and sql_expression are required");
  }

  const entityDsLookup = await appDb.query(
    "SELECT data_source_id FROM semantic_entities WHERE id = $1",
    [semanticEntityId]
  );
  if (entityDsLookup.rowCount === 0) {
    return json(res, 404, { error: "not_found", message: "Semantic entity not found" });
  }
  if (!(await enforceDataSourceAccess(req, res, entityDsLookup.rows[0].data_source_id))) {
    return undefined;
  }

  if (id) {
    const sourceResult = await appDb.query(
      `
        SELECT se.data_source_id
        FROM metric_definitions md
        JOIN semantic_entities se ON se.id = md.semantic_entity_id
        WHERE md.id = $1
      `,
      [id]
    );

    const updateResult = await appDb.query(
      `
        UPDATE metric_definitions
        SET
          semantic_entity_id = $2,
          sql_expression = $3,
          grain = $4,
          filters_json = $5
        WHERE id = $1
        RETURNING id
      `,
      [id, semanticEntityId, sqlExpression, grain || null, filtersJson || null]
    );

    if (updateResult.rowCount === 0) {
      return json(res, 404, { error: "not_found", message: "Metric definition not found" });
    }
    const dataSourceId = sourceResult.rows[0]?.data_source_id || null;
    triggerRagReindexAsync(dataSourceId);
    return json(res, 200, updateResult.rows[0]);
  }

  const sourceResult = await appDb.query(
    "SELECT data_source_id FROM semantic_entities WHERE id = $1",
    [semanticEntityId]
  );
  const dataSourceId = sourceResult.rows[0]?.data_source_id || null;

  const insertResult = await appDb.query(
    `
      INSERT INTO metric_definitions (semantic_entity_id, sql_expression, grain, filters_json)
      VALUES ($1, $2, $3, $4)
      RETURNING id
    `,
    [semanticEntityId, sqlExpression, grain || null, filtersJson || null]
  );

  triggerRagReindexAsync(dataSourceId);
  return json(res, 200, insertResult.rows[0]);
}

async function handleUpsertJoinPolicy(req, res) {
  const body = await readJsonBody(req);
  const {
    id,
    data_source_id: dataSourceId,
    left_ref: leftRef,
    right_ref: rightRef,
    join_type: joinType,
    on_clause: onClause,
    approved,
    notes
  } = body;

  if (!dataSourceId || !leftRef || !rightRef || !joinType || !onClause || typeof approved !== "boolean") {
    return badRequest(res, "data_source_id, left_ref, right_ref, join_type, on_clause, approved are required");
  }

  if (!(await enforceDataSourceAccess(req, res, dataSourceId))) {
    return undefined;
  }

  if (id) {
    const updateResult = await appDb.query(
      `
        UPDATE join_policies
        SET
          data_source_id = $2,
          left_ref = $3,
          right_ref = $4,
          join_type = $5,
          on_clause = $6,
          approved = $7,
          notes = $8
        WHERE id = $1
        RETURNING id
      `,
      [id, dataSourceId, leftRef, rightRef, joinType, onClause, approved, notes || null]
    );
    if (updateResult.rowCount === 0) {
      return json(res, 404, { error: "not_found", message: "Join policy not found" });
    }
    triggerRagReindexAsync(dataSourceId);
    return json(res, 200, updateResult.rows[0]);
  }

  const insertResult = await appDb.query(
    `
      INSERT INTO join_policies (
        data_source_id,
        left_ref,
        right_ref,
        join_type,
        on_clause,
        approved,
        notes
      ) VALUES ($1, $2, $3, $4, $5, $6, $7)
      RETURNING id
    `,
    [dataSourceId, leftRef, rightRef, joinType, onClause, approved, notes || null]
  );

  triggerRagReindexAsync(dataSourceId);
  return json(res, 200, insertResult.rows[0]);
}

module.exports = {
  handleUpsertSemanticEntity,
  handleUpsertMetricDefinition,
  handleUpsertJoinPolicy
};
