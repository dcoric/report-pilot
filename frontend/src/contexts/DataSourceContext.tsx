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
            const { data } = await client.GET('/v1/data-sources');
            if (!data?.items) return;
            setDataSources(data.items);
            const stored = sessionStorage.getItem(SESSION_KEY);
            const valid = stored && data.items.some((ds) => ds.id === stored);
            if (!valid && data.items.length > 0) {
                setSelectedDataSourceId(data.items[0].id);
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
