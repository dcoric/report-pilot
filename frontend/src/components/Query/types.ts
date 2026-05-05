import type { components } from '../../lib/api/types';

export type RunProvider = NonNullable<components['schemas']['RunSessionRequest']['llm_provider']>;

export interface LlmProvider {
    id: string;
    provider: string;
    default_model: string;
    base_url?: string;
    display_name?: string;
    enabled: boolean;
}

export interface CitationCollection {
    schema_objects?: Array<{
        id: string;
        schema_name: string;
        object_name: string;
        object_type: string;
    }>;
    semantic_entities?: Array<{
        id: string;
        entity_type: string;
        business_name: string;
        target_ref: string;
    }>;
    metric_definitions?: Array<{
        id: string;
        business_name: string;
        semantic_entity_id: string;
    }>;
    join_policies?: Array<{
        id: string;
        left_ref: string;
        right_ref: string;
        join_type: string;
    }>;
    rag_documents?: Array<{
        id: string;
        doc_type: string;
        ref_id: string;
        score: number;
        rerank_score: number;
        embedding_model?: string | null;
    }>;
}

export type RunResponse = components['schemas']['RunSessionResponse'] & {
    provider?: {
        name?: string;
        model?: string;
    };
    citations?: CitationCollection;
};

export type PromptHistoryItem = components['schemas']['PromptHistoryItem'];
export type SavedQuery = components['schemas']['SavedQuery'];
export type TabType = 'results' | 'metadata' | 'citations' | 'query-plan';
export type ExportFormat = 'json' | 'csv' | 'xlsx' | 'tsv' | 'parquet';

export interface PromptHistoryPosition {
    top: number;
    left: number;
    width: number;
    panelMaxHeight: number;
}
