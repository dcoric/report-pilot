import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { client } from '../lib/api/client';
import { DataSourceContext, type DataSource } from './dataSourceContextValue';

const SESSION_KEY = 'selectedDataSourceId';

export function DataSourceProvider({ children }: { children: ReactNode }) {
    const [dataSources, setDataSources] = useState<DataSource[]>([]);
    const [selectedDataSourceId, setSelectedDataSourceIdRaw] = useState<string>(
        () => sessionStorage.getItem(SESSION_KEY) ?? ''
    );
    const [isLoadingDataSources, setIsLoadingDataSources] = useState(true);
    const [dataSourceLoadError, setDataSourceLoadError] = useState<string | null>(null);

    const setSelectedDataSourceId = useCallback((id: string) => {
        setSelectedDataSourceIdRaw(id);
        sessionStorage.setItem(SESSION_KEY, id);
    }, []);

    const refreshDataSources = useCallback(async () => {
        setIsLoadingDataSources(true);
        setDataSourceLoadError(null);
        try {
            // AUTH-006: when nothing is in sessionStorage yet, prefer the
            // user's saved default before falling back to "first available".
            // Preferences are optional here; a failure must not hide valid connections.
            const [dsSettled, configSettled] = await Promise.allSettled([
                client.GET('/v1/data-sources'),
                client.GET('/v1/users/me/config'),
            ]);

            if (dsSettled.status === 'rejected'
                || dsSettled.value.error
                || !dsSettled.value.data?.items) {
                throw new Error('The data sources request failed');
            }

            const dsResult = dsSettled.value;
            setDataSources(dsResult.data.items);
            if (configSettled.status === 'rejected' || configSettled.value.error) {
                console.warn('Failed to load user preferences while selecting a data source');
            }
            const stored = sessionStorage.getItem(SESSION_KEY);
            const validStored = stored && dsResult.data.items.some((ds) => ds.id === stored);
            if (validStored) return;

            const preferred = configSettled.status === 'fulfilled'
                ? configSettled.value.data?.config?.default_data_source_id
                : undefined;
            const validPreferred = preferred && dsResult.data.items.some((ds) => ds.id === preferred);
            if (validPreferred) {
                setSelectedDataSourceId(preferred as string);
            } else if (dsResult.data.items.length > 0) {
                setSelectedDataSourceId(dsResult.data.items[0].id);
            } else {
                setSelectedDataSourceId('');
            }
        } catch (error) {
            console.error('Failed to load data sources', error);
            setDataSourceLoadError('We could not load your database connections. Check your connection and try again.');
        } finally {
            setIsLoadingDataSources(false);
        }
    }, [setSelectedDataSourceId]);

    useEffect(() => {
        void refreshDataSources();
    }, [refreshDataSources]);

    const value = useMemo(
        () => ({
            dataSources,
            selectedDataSourceId,
            setSelectedDataSourceId,
            isLoadingDataSources,
            dataSourceLoadError,
            refreshDataSources,
        }),
        [
            dataSources,
            selectedDataSourceId,
            setSelectedDataSourceId,
            isLoadingDataSources,
            dataSourceLoadError,
            refreshDataSources,
        ],
    );

    return <DataSourceContext.Provider value={value}>{children}</DataSourceContext.Provider>;
}
