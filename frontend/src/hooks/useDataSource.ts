import { useContext } from 'react';
import { DataSourceContext } from '../contexts/dataSourceContextValue';

export function useDataSource() {
    const ctx = useContext(DataSourceContext);
    if (!ctx) {
        throw new Error('useDataSource must be used inside DataSourceProvider');
    }
    return ctx;
}
