import { createContext } from 'react';
import type { components } from '../lib/api/types';

export type DataSource = components['schemas']['DataSourceListResponse']['items'][number];

export interface DataSourceContextValue {
    dataSources: DataSource[];
    selectedDataSourceId: string;
    setSelectedDataSourceId: (id: string) => void;
}

export const DataSourceContext = createContext<DataSourceContextValue | null>(null);
