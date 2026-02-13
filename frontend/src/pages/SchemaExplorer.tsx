import React, { useEffect, useState } from 'react';
import { Database, Search, RefreshCw, Layers, Link as LinkIcon } from 'lucide-react';
import { client } from '../lib/api/client';
import { SchemaObjectList } from '../components/Schema/SchemaObjectList';
import { JoinPolicyDialog } from '../components/Semantic/JoinPolicyDialog';
import type { components } from '../lib/api/types';

type DataSource = components['schemas']['DataSourceListResponse']['items'][number];
type SchemaObject = components['schemas']['SchemaObject'];

export const SchemaExplorer: React.FC = () => {
    const [dataSources, setDataSources] = useState<DataSource[]>([]);
    const [selectedDataSourceId, setSelectedDataSourceId] = useState<string>('');
    const [schemaObjects, setSchemaObjects] = useState<SchemaObject[]>([]);
    const [isLoadingSources, setIsLoadingSources] = useState(true);
    const [isLoadingObjects, setIsLoadingObjects] = useState(false);
    const [filter, setFilter] = useState('');
    const [isJoinDialogOpen, setIsJoinDialogOpen] = useState(false); // Join Dialog State

    // Fetch Data Sources on mount
    useEffect(() => {
        const fetchDataSources = async () => {
            setIsLoadingSources(true);
            try {
                const { data } = await client.GET('/v1/data-sources');
                if (data && data.items) {
                    setDataSources(data.items);
                    if (data.items.length > 0) {
                        setSelectedDataSourceId(data.items[0].id);
                    }
                }
            } catch (error) {
                console.error("Failed to fetch data sources", error);
            } finally {
                setIsLoadingSources(false);
            }
        };
        fetchDataSources();
    }, []);

    // Fetch Schema Objects when selected data source changes
    useEffect(() => {
        if (!selectedDataSourceId) {
            setSchemaObjects([]);
            return;
        }

        const fetchSchemaObjects = async () => {
            setIsLoadingObjects(true);
            try {
                const { data } = await client.GET('/v1/schema-objects', {
                    params: { query: { data_source_id: selectedDataSourceId } }
                });
                if (data && data.items) {
                    setSchemaObjects(data.items);
                } else {
                    setSchemaObjects([]);
                }
            } catch (error) {
                console.error("Failed to fetch schema objects", error);
                setSchemaObjects([]);
            } finally {
                setIsLoadingObjects(false);
            }
        };

        fetchSchemaObjects();
    }, [selectedDataSourceId]);

    return (
        <div className="h-full flex flex-col">
            <div className="flex justify-between items-center mb-6">
                <div>
                    <h1 className="text-2xl font-bold text-gray-900">Schema Explorer</h1>
                    <p className="text-gray-500 mt-1">Browse tables and views in your data sources.</p>
                </div>
                <button
                    onClick={() => setIsJoinDialogOpen(true)}
                    className="inline-flex items-center px-4 py-2 border border-gray-300 shadow-sm text-sm font-medium rounded-md text-gray-700 bg-white hover:bg-gray-50 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-blue-500"
                    disabled={!selectedDataSourceId}
                >
                    <LinkIcon className="-ml-1 mr-2 h-4 w-4" aria-hidden="true" />
                    Join Policies
                </button>
            </div>

            <div className="flex flex-col gap-4 flex-1 overflow-hidden">
                {/* Controls Bar */}
                <div className="bg-white p-4 rounded-lg shadow border border-gray-200 flex flex-wrap gap-4 items-center">

                    {/* Data Source Selector */}
                    <div className="flex items-center gap-2 min-w-[250px]">
                        <Database size={18} className="text-gray-500" />
                        <select
                            value={selectedDataSourceId}
                            onChange={(e) => setSelectedDataSourceId(e.target.value)}
                            className="block w-full rounded-md border-gray-300 shadow-sm focus:border-blue-500 focus:ring-blue-500 sm:text-sm p-2 border"
                            disabled={isLoadingSources || dataSources.length === 0}
                        >
                            {isLoadingSources ? (
                                <option>Loading sources...</option>
                            ) : dataSources.length === 0 ? (
                                <option>No data sources found</option>
                            ) : (
                                dataSources.map(ds => (
                                    <option key={ds.id} value={ds.id}>{ds.name} ({ds.db_type})</option>
                                ))
                            )}
                        </select>
                    </div>

                    {/* Search Filter */}
                    <div className="flex-1 flex items-center gap-2 relative">
                        <Search size={18} className="text-gray-400 absolute left-3" />
                        <input
                            type="text"
                            placeholder="Search tables and views..."
                            className="block w-full rounded-md border-gray-300 pl-10 shadow-sm focus:border-blue-500 focus:ring-blue-500 sm:text-sm p-2 border"
                            value={filter}
                            onChange={(e) => setFilter(e.target.value)}
                        />
                    </div>
                </div>

                {/* Content Area */}
                <div className="flex-1 overflow-y-auto">
                    {isLoadingObjects ? (
                        <div className="flex flex-col items-center justify-center h-64 text-gray-500">
                            <RefreshCw className="animate-spin mb-2" size={24} />
                            <p>Loading schema objects...</p>
                        </div>
                    ) : !selectedDataSourceId ? (
                        <div className="flex flex-col items-center justify-center h-64 text-gray-500">
                            <Database size={48} className="mb-4 opacity-20" />
                            <p>Select a data source to view its schema.</p>
                        </div>
                    ) : schemaObjects.length === 0 ? (
                        <div className="flex flex-col items-center justify-center h-64 text-gray-500">
                            <Layers size={48} className="mb-4 opacity-20" />
                            <p className="text-lg font-medium">No schema objects found</p>
                            <p className="text-sm">Try running introspection on this data source.</p>
                        </div>
                    ) : (
                        <div className="bg-white rounded-lg shadow overflow-hidden border border-gray-200">
                            <SchemaObjectList objects={schemaObjects} filter={filter} dataSourceId={selectedDataSourceId} />
                        </div>
                    )}
                </div>
            </div>

            <JoinPolicyDialog
                isOpen={isJoinDialogOpen}
                onClose={() => setIsJoinDialogOpen(false)}
                dataSourceId={selectedDataSourceId}
            />
        </div>
    );
};
