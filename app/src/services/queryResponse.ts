import type { ParsedRef } from "./sqlAstValidator";

export interface CitationSchemaObject {
  id: string;
  schema_name: string;
  object_name: string;
  object_type: string;
}

export interface CitationSemanticEntity {
  id: string;
  entity_type: string;
  business_name: string;
  target_ref: string;
}

export interface CitationMetricDefinition {
  id: string;
  business_name: string;
  semantic_entity_id: string;
}

export interface CitationJoinPolicy {
  id: string;
  left_ref: string;
  right_ref: string;
  join_type: string;
}

export interface Citations {
  schema_objects: CitationSchemaObject[];
  semantic_entities: CitationSemanticEntity[];
  metric_definitions: CitationMetricDefinition[];
  join_policies: CitationJoinPolicy[];
  rag_documents?: Array<{
    id: string;
    doc_type: string;
    ref_id: string;
    score: number;
    rerank_score: number;
    embedding_model: string | null;
  }>;
}

interface BuildCitationsInput {
  question: string;
  sql: string;
  refs: ParsedRef[] | unknown[];
  schemaObjects: Array<{ id: string; schema_name: string; object_name: string; object_type: string }>;
  semanticEntities?: Array<{ id: string; entity_type: string; business_name: string; target_ref: string }>;
  metricDefinitions?: Array<{ id: string; business_name: string; semantic_entity_id: string }>;
  joinPolicies?: Array<{ id: string; left_ref: string; right_ref: string; join_type: string }>;
}

interface ComputeConfidenceInput {
  provider: string;
  attempts?: Array<{ status: string }>;
  citations?: Citations;
}

function clamp(n: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, n));
}

function normalizeText(value: unknown): string {
  return String(value || "").toLowerCase();
}

export function buildCitations(input: BuildCitationsInput): Citations {
  const {
    question,
    sql,
    refs,
    schemaObjects,
    semanticEntities,
    metricDefinitions,
    joinPolicies
  } = input;

  const refKeys = new Set((refs as ParsedRef[] || []).map((ref) => `${ref.schema}.${ref.object}`));
  const schemaObjectCitations: CitationSchemaObject[] = (schemaObjects || [])
    .filter((obj) => refKeys.has(`${obj.schema_name.toLowerCase()}.${obj.object_name.toLowerCase()}`))
    .map((obj) => ({
      id: obj.id,
      schema_name: obj.schema_name,
      object_name: obj.object_name,
      object_type: obj.object_type
    }));

  const questionText = normalizeText(question);
  const sqlText = normalizeText(sql);

  const semanticCitations: CitationSemanticEntity[] = (semanticEntities || [])
    .filter((entity) => {
      const targetRef = normalizeText(entity.target_ref);
      const businessName = normalizeText(entity.business_name);

      for (const key of refKeys) {
        if (targetRef.includes(key)) {
          return true;
        }
      }

      return Boolean(businessName) && questionText.includes(businessName);
    })
    .map((entity) => ({
      id: entity.id,
      entity_type: entity.entity_type,
      business_name: entity.business_name,
      target_ref: entity.target_ref
    }));

  const metricCitations: CitationMetricDefinition[] = (metricDefinitions || [])
    .filter((metric) => {
      const businessName = normalizeText(metric.business_name);
      return Boolean(businessName) && questionText.includes(businessName);
    })
    .map((metric) => ({
      id: metric.id,
      business_name: metric.business_name,
      semantic_entity_id: metric.semantic_entity_id
    }));

  const joinCitations: CitationJoinPolicy[] = (joinPolicies || [])
    .filter((join) => {
      const left = normalizeText(join.left_ref);
      const right = normalizeText(join.right_ref);
      return (Boolean(left) && sqlText.includes(left)) || (Boolean(right) && sqlText.includes(right));
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

export function computeConfidence(input: ComputeConfidenceInput): number {
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
