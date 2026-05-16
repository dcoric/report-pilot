import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { client } from '../lib/api/client';
import { DataSourceContext, type DataSource } from './dataSourceContextValue';

const SESSION_KEY = 'selectedDataSourceId';

export function DataSourceProvider({ children }: { children: ReactNode }) {
    const [dataSources, setDataSources] = useState<DataSource[]>([]);
    const [selectedDataSourceId, setSelectedDataSourceIdRaw] = useState<string>(
        () => sessionStorage.getItem(SESSION_KEY) ?? ''
    );

    const setSelectedDataSourceId = useCallback((id: string) => {
        setSelectedDataSourceIdRaw(id);
        sessionStorage.setItem(SESSION_KEY, id);
    }, []);

    useEffect(() => {
        const fetchDataSources = async () => {
            // AUTH-006: when nothing is in sessionStorage yet, prefer the
            // user's saved default before falling back to "first available".
            const [dsResult, configResult] = await Promise.all([
                client.GET('/v1/data-sources'),
                client.GET('/v1/users/me/config'),
            ]);
            if (!dsResult.data?.items) return;
            setDataSources(dsResult.data.items);
            const stored = sessionStorage.getItem(SESSION_KEY);
            const validStored = stored && dsResult.data.items.some((ds) => ds.id === stored);
            if (validStored) return;
            const preferred = configResult.data?.config?.default_data_source_id;
            const validPreferred = preferred && dsResult.data.items.some((ds) => ds.id === preferred);
            if (validPreferred) {
                setSelectedDataSourceId(preferred as string);
            } else if (dsResult.data.items.length > 0) {
                setSelectedDataSourceId(dsResult.data.items[0].id);
            }
        };
        void fetchDataSources();
    }, [setSelectedDataSourceId]);

    const value = useMemo(
        () => ({ dataSources, selectedDataSourceId, setSelectedDataSourceId }),
        [dataSources, selectedDataSourceId, setSelectedDataSourceId],
    );

    return <DataSourceContext.Provider value={value}>{children}</DataSourceContext.Provider>;
}
