import appDb = require("../lib/appDb");
import ragRetrieval = require("./ragRetrieval");
import type { RagRetrievalDoc } from "./ragRetrieval";
import { getOrLoadSchemaArtifact, loadCurrentSchemaVersion } from "./schemaArtifactCache";

const { retrieveRagContext } = ragRetrieval;

export interface TableCardRelationship {
  column: string;
  related_ref: string;
  related_column: string;
  direction: "outbound" | "inbound";
  relationship_type: string;
}

export interface TableCard {
  id: string;
  schema_name: string;
  object_name: string;
  object_type: string;
  description: string | null;
  primary_keys: string[];
  join_columns: string[];
  relationships: TableCardRelationship[];
  approved_join_refs: string[];
  semantic_aliases: string[];
  synonyms: Array<{ term: string; weight: number }>;
}

export interface TableCandidate extends TableCard {
  score: number;
  lexical_score: number;
  rag_score: number;
  matched_terms: string[];
}

export interface RetrieveTableCandidatesOptions {
  limit?: number;
  ragLimit?: number;
}

interface SchemaObjectRow {
  id: string;
  schema_name: string;
  object_name: string;
  object_type: string;
  description: string | null;
}

interface KeyColumnRow {
  schema_object_id: string;
  column_name: string;
}

interface RelationshipRow {
  from_object_id: string;
  from_column: string;
  from_schema: string;
  from_object: string;
  to_object_id: string;
  to_column: string;
  to_schema: string;
  to_object: string;
  relationship_type: string;
}

interface SemanticRow {
  target_ref: string;
  business_name: string;
}

interface SynonymRow {
  term: string;
  maps_to_ref: string;
  weight: number | string;
}

interface JoinPolicyRow {
  left_ref: string;
  right_ref: string;
}

export async function retrieveTableCandidates(
  dataSourceId: string,
  question: string,
  opts: RetrieveTableCandidatesOptions = {}
): Promise<TableCandidate[]> {
  const q = String(question || "").trim();
  if (!q) {
    return [];
  }

  const limit = positiveInteger(opts.limit, 15);
  const ragLimit = positiveInteger(opts.ragLimit, Math.max(limit * 3, 30));
  const [cards, ragDocuments] = await Promise.all([
    loadTableCards(dataSourceId),
    retrieveRagContext(dataSourceId, q, { limit: ragLimit })
  ]);

  return rankTableCards(q, cards, ragDocuments, limit);
}

export async function loadTableCards(dataSourceId: string): Promise<TableCard[]> {
  const schemaVersion = await loadCurrentSchemaVersion(dataSourceId);
  return getOrLoadSchemaArtifact("table_cards", dataSourceId, schemaVersion, () => buildTableCards(dataSourceId));
}

async function buildTableCards(dataSourceId: string): Promise<TableCard[]> {
  const [objectsResult, primaryKeysResult, relationshipsResult, semanticResult, synonymsResult, joinsResult] =
    await Promise.all([
      appDb.query<SchemaObjectRow>(
        `
          SELECT id, schema_name, object_name, object_type, description
          FROM schema_objects
          WHERE data_source_id = $1
            AND is_ignored = FALSE
            AND object_type IN ('table', 'view', 'materialized_view')
          ORDER BY schema_name, object_name
        `,
        [dataSourceId]
      ),
      appDb.query<KeyColumnRow>(
        `
          SELECT c.schema_object_id, c.column_name
          FROM columns c
          JOIN schema_objects so ON so.id = c.schema_object_id
          WHERE so.data_source_id = $1
            AND so.is_ignored = FALSE
            AND c.is_pk = TRUE
          ORDER BY c.schema_object_id, c.ordinal_position
        `,
        [dataSourceId]
      ),
      appDb.query<RelationshipRow>(
        `
          SELECT
            r.from_object_id,
            r.from_column,
            source.schema_name AS from_schema,
            source.object_name AS from_object,
            r.to_object_id,
            r.to_column,
            target.schema_name AS to_schema,
            target.object_name AS to_object,
            r.relationship_type
          FROM relationships r
          JOIN schema_objects source ON source.id = r.from_object_id
          JOIN schema_objects target ON target.id = r.to_object_id
          WHERE source.data_source_id = $1
            AND target.data_source_id = $1
            AND source.is_ignored = FALSE
            AND target.is_ignored = FALSE
        `,
        [dataSourceId]
      ),
      appDb.query<SemanticRow>(
        `
          SELECT target_ref, business_name
          FROM semantic_entities
          WHERE data_source_id = $1 AND active = TRUE
          ORDER BY business_name
        `,
        [dataSourceId]
      ),
      appDb.query<SynonymRow>(
        `
          SELECT term, maps_to_ref, weight
          FROM synonyms
          WHERE data_source_id = $1
          ORDER BY term
        `,
        [dataSourceId]
      ),
      appDb.query<JoinPolicyRow>(
        `
          SELECT left_ref, right_ref
          FROM join_policies
          WHERE data_source_id = $1 AND approved = TRUE
          ORDER BY left_ref, right_ref
        `,
        [dataSourceId]
      )
    ]);

  const cards = objectsResult.rows.map<TableCard>((row) => ({
    ...row,
    primary_keys: [],
    join_columns: [],
    relationships: [],
    approved_join_refs: [],
    semantic_aliases: [],
    synonyms: []
  }));
  const cardsById = new Map(cards.map((card) => [card.id, card]));
  const resolveCard = buildCardResolver(cards);

  for (const key of primaryKeysResult.rows) {
    cardsById.get(key.schema_object_id)?.primary_keys.push(key.column_name);
  }

  for (const relationship of relationshipsResult.rows) {
    const from = cardsById.get(relationship.from_object_id);
    const to = cardsById.get(relationship.to_object_id);
    if (from) {
      from.join_columns.push(relationship.from_column);
      from.relationships.push({
        column: relationship.from_column,
        related_ref: `${relationship.to_schema}.${relationship.to_object}`,
        related_column: relationship.to_column,
        direction: "outbound",
        relationship_type: relationship.relationship_type
      });
    }
    if (to) {
      to.join_columns.push(relationship.to_column);
      to.relationships.push({
        column: relationship.to_column,
        related_ref: `${relationship.from_schema}.${relationship.from_object}`,
        related_column: relationship.from_column,
        direction: "inbound",
        relationship_type: relationship.relationship_type
      });
    }
  }

  for (const semantic of semanticResult.rows) {
    const card = resolveCard(semantic.target_ref);
    if (card) {
      card.semantic_aliases.push(semantic.business_name);
    }
  }

  for (const synonym of synonymsResult.rows) {
    const card = resolveCard(synonym.maps_to_ref);
    if (card) {
      card.synonyms.push({ term: synonym.term, weight: finiteNumber(synonym.weight, 1) });
    }
  }

  for (const join of joinsResult.rows) {
    const left = resolveCard(join.left_ref);
    const right = resolveCard(join.right_ref);
    if (left && right) {
      left.approved_join_refs.push(qualifiedRef(right));
      right.approved_join_refs.push(qualifiedRef(left));
    }
  }

  for (const card of cards) {
    card.primary_keys = uniqueSorted(card.primary_keys);
    card.join_columns = uniqueSorted(card.join_columns);
    card.approved_join_refs = uniqueSorted(card.approved_join_refs);
    card.semantic_aliases = uniqueSorted(card.semantic_aliases);
    card.synonyms = uniqueBy(card.synonyms, (entry) => normalizeText(entry.term));
  }

  return cards;
}

export function rankTableCards(
  question: string,
  cards: TableCard[],
  ragDocuments: RagRetrievalDoc[] = [],
  limit = 15
): TableCandidate[] {
  const q = normalizeText(question);
  if (!q) {
    return [];
  }

  const questionTerms = tokenize(question);
  const ragScores = new Map<string, number>();
  for (const doc of ragDocuments) {
    if (doc.doc_type !== "schema") {
      continue;
    }
    const score = finiteNumber(doc.rerank_score, finiteNumber(doc.score, 0));
    ragScores.set(String(doc.ref_id), Math.max(ragScores.get(String(doc.ref_id)) || 0, score));
  }

  return cards
    .map<TableCandidate>((card) => {
      const objectRef = qualifiedRef(card);
      const objectTerms = new Set(tokenize(`${card.schema_name} ${card.object_name}`));
      const descriptiveTerms = new Set(tokenize([
        card.description,
        ...card.semantic_aliases,
        ...card.synonyms.map((entry) => entry.term)
      ].join(" ")));
      const matchedTerms = questionTerms.filter((term) => objectTerms.has(term) || descriptiveTerms.has(term));

      let lexicalScore = 0;
      if (q.includes(normalizeText(objectRef))) {
        lexicalScore += 8;
      } else if (q.includes(normalizeText(card.object_name))) {
        lexicalScore += 5;
      }
      for (const term of new Set(questionTerms)) {
        if (objectTerms.has(term)) {
          lexicalScore += 2;
        } else if (descriptiveTerms.has(term)) {
          lexicalScore += 1;
        }
      }
      for (const synonym of card.synonyms) {
        if (phraseMatches(q, synonym.term)) {
          lexicalScore += Math.max(0, synonym.weight) * 2;
        }
      }
      for (const alias of card.semantic_aliases) {
        if (phraseMatches(q, alias)) {
          lexicalScore += 2;
        }
      }

      const ragScore = ragScores.get(card.id) || 0;
      return {
        ...card,
        score: roundScore(lexicalScore + ragScore),
        lexical_score: roundScore(lexicalScore),
        rag_score: roundScore(ragScore),
        matched_terms: uniqueSorted(matchedTerms)
      };
    })
    .filter((candidate) => candidate.score > 0)
    .sort((a, b) => b.score - a.score || a.schema_name.localeCompare(b.schema_name) || a.object_name.localeCompare(b.object_name))
    .slice(0, positiveInteger(limit, 15));
}

export function refMatchesCard(ref: string, card: Pick<TableCard, "schema_name" | "object_name">): boolean {
  const normalized = normalizeRef(ref);
  const qualified = normalizeRef(qualifiedRef(card));
  const object = normalizeRef(card.object_name);
  return normalized === qualified
    || normalized.startsWith(`${qualified}.`)
    || normalized === object
    || normalized.startsWith(`${object}.`);
}

function buildCardResolver(cards: TableCard[]): (ref: string) => TableCard | undefined {
  const qualified = new Map(cards.map((card) => [normalizeRef(qualifiedRef(card)), card]));
  const unqualified = new Map<string, TableCard | null>();
  for (const card of cards) {
    const key = normalizeRef(card.object_name);
    unqualified.set(key, unqualified.has(key) ? null : card);
  }

  return (ref: string) => {
    const normalized = normalizeRef(ref);
    const parts = normalized.split(".").filter(Boolean);
    for (let end = parts.length; end > 0; end -= 1) {
      const direct = qualified.get(parts.slice(0, end).join("."));
      if (direct) {
        return direct;
      }
    }
    const byObjectName = unqualified.get(parts[0] || normalized);
    return byObjectName || undefined;
  };
}

function qualifiedRef(card: Pick<TableCard, "schema_name" | "object_name">): string {
  return `${card.schema_name}.${card.object_name}`;
}

function phraseMatches(normalizedQuestion: string, phrase: string): boolean {
  const normalizedPhrase = normalizeText(phrase);
  return Boolean(normalizedPhrase) && normalizedQuestion.includes(normalizedPhrase);
}

function tokenize(value: unknown): string[] {
  return normalizeText(String(value || "").replace(/([a-z0-9])([A-Z])/g, "$1 $2"))
    .replace(/[^a-z0-9]+/g, " ")
    .split(/\s+/)
    .filter((term) => term.length >= 2);
}

function normalizeText(value: unknown): string {
  return String(value || "").trim().toLowerCase();
}

function normalizeRef(value: unknown): string {
  return normalizeText(value).replace(/["'`\[\]]/g, "").replace(/\s+/g, "");
}

function positiveInteger(value: unknown, fallback: number): number {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : fallback;
}

function finiteNumber(value: unknown, fallback: number): number {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function roundScore(value: number): number {
  return Number(value.toFixed(4));
}

function uniqueSorted(values: string[]): string[] {
  return [...new Set(values)].sort((a, b) => a.localeCompare(b));
}

function uniqueBy<T>(values: T[], key: (value: T) => string): T[] {
  const seen = new Set<string>();
  return values.filter((value) => {
    const identifier = key(value);
    if (seen.has(identifier)) {
      return false;
    }
    seen.add(identifier);
    return true;
  });
}
