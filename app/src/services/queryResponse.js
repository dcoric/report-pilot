function clamp(n, min, max) {
  return Math.max(min, Math.min(max, n));
}

function normalizeText(value) {
  return String(value || "").toLowerCase();
}

function buildCitations(input) {
  const {
    question,
    sql,
    refs,
    schemaObjects,
    semanticEntities,
    metricDefinitions,
    joinPolicies
  } = input;

  const refKeys = new Set((refs || []).map((ref) => `${ref.schema}.${ref.object}`));
  const schemaObjectCitations = (schemaObjects || [])
    .filter((obj) => refKeys.has(`${obj.schema_name.toLowerCase()}.${obj.object_name.toLowerCase()}`))
    .map((obj) => ({
      id: obj.id,
      schema_name: obj.schema_name,
      object_name: obj.object_name,
      object_type: obj.object_type
    }));

  const questionText = normalizeText(question);
  const sqlText = normalizeText(sql);

  const semanticCitations = (semanticEntities || [])
    .filter((entity) => {
      const targetRef = normalizeText(entity.target_ref);
      const businessName = normalizeText(entity.business_name);

      for (const key of refKeys) {
        if (targetRef.includes(key)) {
          return true;
        }
      }

      return businessName && questionText.includes(businessName);
    })
    .map((entity) => ({
      id: entity.id,
      entity_type: entity.entity_type,
      business_name: entity.business_name,
      target_ref: entity.target_ref
    }));

  const metricCitations = (metricDefinitions || [])
    .filter((metric) => {
      const businessName = normalizeText(metric.business_name);
      return businessName && questionText.includes(businessName);
    })
    .map((metric) => ({
      id: metric.id,
      business_name: metric.business_name,
      semantic_entity_id: metric.semantic_entity_id
    }));

  const joinCitations = (joinPolicies || [])
    .filter((join) => {
      const left = normalizeText(join.left_ref);
      const right = normalizeText(join.right_ref);
      return (left && sqlText.includes(left)) || (right && sqlText.includes(right));
    })
    .map((join) => ({
      id: join.id,
      left_ref: join.left_ref,
      right_ref: join.right_ref,
      join_type: join.join_type
    }));

  return {
    schema_objects: schemaObjectCitations,
    semantic_entities: semanticCitations,
    metric_definitions: metricCitations,
    join_policies: joinCitations
  };
}

function computeConfidence(input) {
  const { provider, attempts, citations } = input;

  let score = provider === "local-fallback" ? 0.25 : 0.65;

  if ((citations?.schema_objects || []).length > 0) {
    score += 0.1;
  }
  if ((citations?.semantic_entities || []).length > 0) {
    score += 0.1;
  }
  if ((citations?.metric_definitions || []).length > 0) {
    score += 0.05;
  }

  const failedAttempts = (attempts || []).filter((attempt) => attempt.status === "failed").length;
  score -= Math.min(0.2, failedAttempts * 0.05);

  return Number(clamp(score, 0.05, 0.95).toFixed(2));
}

module.exports = {
  buildCitations,
  computeConfidence
};
