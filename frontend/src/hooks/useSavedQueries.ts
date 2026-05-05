import { useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';
import { client } from '../lib/api/client';
import type { SavedQuery } from '../components/Query/types';

const SAVED_QUERY_NAME_MAX_LENGTH = 200;

function sortSavedQueries(items: SavedQuery[]) {
    return [...items].sort((left, right) => {
        const updatedDiff = new Date(right.updated_at).getTime() - new Date(left.updated_at).getTime();
        if (updatedDiff !== 0) {
            return updatedDiff;
        }
        return new Date(right.created_at).getTime() - new Date(left.created_at).getTime();
    });
}

function buildDuplicateName(baseName: string, attempt: number) {
    const suffix = attempt === 1 ? ' Copy' : ` Copy ${attempt}`;
    const trimmedBase = baseName.trim() || 'Untitled query';
    const prefix = trimmedBase.slice(0, Math.max(1, SAVED_QUERY_NAME_MAX_LENGTH - suffix.length)).trimEnd();
    return `${prefix}${suffix}`;
}

export interface UseSavedQueriesResult {
    savedQueries: SavedQuery[];
    isLoading: boolean;
    errorMessage: string | null;
    refresh: () => Promise<void>;
    createSavedQuery: (input: {
        name: string;
        description?: string;
        dataSourceId: string;
        sql: string;
        defaultRunParams: SavedQuery['default_run_params'];
        parameterSchema?: SavedQuery['parameter_schema'];
        tags?: string[];
    }) => Promise<SavedQuery | null>;
    updateSavedQuery: (
        savedQueryId: string,
        input: {
            name: string;
            description?: string;
            dataSourceId: string;
            sql: string;
            defaultRunParams: SavedQuery['default_run_params'];
            parameterSchema?: SavedQuery['parameter_schema'];
            tags?: string[];
        }
    ) => Promise<SavedQuery | null>;
    duplicateSavedQuery: (savedQuery: SavedQuery) => Promise<SavedQuery | null>;
    deleteSavedQuery: (savedQueryId: string) => Promise<boolean>;
}

export function useSavedQueries(): UseSavedQueriesResult {
    const [savedQueries, setSavedQueries] = useState<SavedQuery[]>([]);
    const [isLoading, setIsLoading] = useState(true);
    const [errorMessage, setErrorMessage] = useState<string | null>(null);

    const refresh = useCallback(async () => {
        setIsLoading(true);
        setErrorMessage(null);
        try {
            const { data, error } = await client.GET('/v1/saved-queries');
            if (error) {
                setErrorMessage('Failed to load saved queries.');
                return;
            }
            setSavedQueries(sortSavedQueries(data?.items ?? []));
        } catch (error) {
            console.error('Failed to fetch saved queries', error);
            setErrorMessage('Failed to load saved queries.');
        } finally {
            setIsLoading(false);
        }
    }, []);

    useEffect(() => {
        void refresh();
    }, [refresh]);

    const createSavedQuery = useCallback<UseSavedQueriesResult['createSavedQuery']>(async (input) => {
        try {
            const { data, error } = await client.POST('/v1/saved-queries', {
                body: {
                    name: input.name,
                    description: input.description || undefined,
                    data_source_id: input.dataSourceId,
                    sql: input.sql,
                    default_run_params: input.defaultRunParams,
                    parameter_schema: input.parameterSchema,
                    tags: input.tags,
                },
            });
            if (error || !data) {
                toast.error(error?.message || 'Failed to save query.');
                return null;
            }
            setSavedQueries((current) => sortSavedQueries([data, ...current]));
            return data;
        } catch (error) {
            console.error('Failed to create saved query', error);
            toast.error('Failed to save query.');
            return null;
        }
    }, []);

    const updateSavedQuery = useCallback<UseSavedQueriesResult['updateSavedQuery']>(async (savedQueryId, input) => {
        try {
            const { data, error } = await client.PUT('/v1/saved-queries/{savedQueryId}', {
                params: { path: { savedQueryId } },
                body: {
                    name: input.name,
                    description: input.description || undefined,
                    data_source_id: input.dataSourceId,
                    sql: input.sql,
                    default_run_params: input.defaultRunParams,
                    parameter_schema: input.parameterSchema,
                    tags: input.tags,
                },
            });
            if (error || !data) {
                toast.error(error?.message || 'Failed to update saved query.');
                return null;
            }
            setSavedQueries((current) => sortSavedQueries(current.map((item) => (item.id === data.id ? data : item))));
            return data;
        } catch (error) {
            console.error('Failed to update saved query', error);
            toast.error('Failed to update saved query.');
            return null;
        }
    }, []);

    const duplicateSavedQuery = useCallback<UseSavedQueriesResult['duplicateSavedQuery']>(async (savedQuery) => {
        for (let attempt = 1; attempt <= 25; attempt += 1) {
            const nextName = buildDuplicateName(savedQuery.name, attempt);
            const { data, response, error } = await client.POST('/v1/saved-queries', {
                body: {
                    name: nextName,
                    description: savedQuery.description || undefined,
                    data_source_id: savedQuery.data_source_id,
                    sql: savedQuery.sql,
                    default_run_params: savedQuery.default_run_params,
                    parameter_schema: savedQuery.parameter_schema,
                    tags: savedQuery.tags,
                },
            });
            if (data) {
                setSavedQueries((current) => sortSavedQueries([data, ...current]));
                toast.success(`Duplicated as "${data.name}".`);
                return data;
            }
            if (response.status === 409) {
                continue;
            }
            toast.error(error?.message || 'Failed to duplicate saved query.');
            return null;
        }
        toast.error('Could not find an available duplicate name.');
        return null;
    }, []);

    const deleteSavedQuery = useCallback<UseSavedQueriesResult['deleteSavedQuery']>(async (savedQueryId) => {
        try {
            const { data, error } = await client.DELETE('/v1/saved-queries/{savedQueryId}', {
                params: { path: { savedQueryId } },
            });
            if (error || !data?.ok) {
                toast.error(error?.message || 'Failed to delete saved query.');
                return false;
            }
            setSavedQueries((current) => current.filter((item) => item.id !== savedQueryId));
            return true;
        } catch (error) {
            console.error('Failed to delete saved query', error);
            toast.error('Failed to delete saved query.');
            return false;
        }
    }, []);

    return {
        savedQueries,
        isLoading,
        errorMessage,
        refresh,
        createSavedQuery,
        updateSavedQuery,
        duplicateSavedQuery,
        deleteSavedQuery,
    };
}
