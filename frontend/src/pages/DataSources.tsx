import React, { useEffect, useState } from 'react';
import { Plus, Database, RefreshCw, Sparkles } from 'lucide-react';
import { format } from 'date-fns';
import { toast } from 'sonner';
import { client } from '../lib/api/client';
import { AddDataSourceDialog } from '../components/DataSources/AddDataSourceDialog';
import type { components } from '../lib/api/types';

type DataSource = components['schemas']['DataSourceListResponse']['items'][number];

export const DataSources: React.FC = () => {
    const [dataSources, setDataSources] = useState<DataSource[]>([]);
    const [isLoading, setIsLoading] = useState(true);
    const [isAddDialogOpen, setIsAddDialogOpen] = useState(false);
    const [introspectingIds, setIntrospectingIds] = useState<Set<string>>(new Set());

    const fetchDataSources = async () => {
        setIsLoading(true);
        try {
            const { data } = await client.GET('/v1/data-sources');
            if (data && data.items) {
                setDataSources(data.items);
            }
        } catch (error) {
            console.error("Failed to fetch data sources", error);
        } finally {
            setIsLoading(false);
        }
    };

    const handleIntrospect = async (ds: DataSource) => {
        if (introspectingIds.has(ds.id)) return;

        setIntrospectingIds(prev => new Set(prev).add(ds.id));
        toast.info(`Started introspection for ${ds.name}...`);

        try {
            // Trigger introspection
            const { error: triggerError } = await client.POST('/v1/data-sources/{dataSourceId}/introspect', {
                params: { path: { dataSourceId: ds.id } }
            });

            if (triggerError) {
                throw new Error("Failed to trigger introspection");
            }

            // Poll for completion (max 30s)
            const startTime = Date.now();
            const POLL_INTERVAL = 2000;
            const TIMEOUT = 30000;

            const checkSchema = async () => {
                const { data } = await client.GET('/v1/schema-objects', {
                    params: { query: { data_source_id: ds.id } }
                });
                return data?.items && data.items.length > 0;
            };

            const poll = async () => {
                if (Date.now() - startTime > TIMEOUT) {
                    setIntrospectingIds(prev => {
                        const next = new Set(prev);
                        next.delete(ds.id);
                        return next;
                    });
                    toast.error(`Introspection timed out for ${ds.name} (no schema objects found).`);
                    return;
                }

                const hasObjects = await checkSchema();
                if (hasObjects) {
                    setIntrospectingIds(prev => {
                        const next = new Set(prev);
                        next.delete(ds.id);
                        return next;
                    });
                    toast.success(`Introspection verified for ${ds.name}!`);
                    fetchDataSources(); // Refresh status if backend updates it
                } else {
                    setTimeout(poll, POLL_INTERVAL);
                }
            };

            poll();

        } catch (err) {
            console.error(err);
            setIntrospectingIds(prev => {
                const next = new Set(prev);
                next.delete(ds.id);
                return next;
            });
            toast.error(`Failed to introspect ${ds.name}`);
        }
    };

    const handleReindex = async (id: string, name: string) => {
        try {
            const { error } = await client.POST('/v1/rag/reindex', {
                params: { query: { data_source_id: id } }
            });

            if (error) {
                toast.error(`Failed to trigger reindex for ${name}`);
            } else {
                toast.success(`RAG reindexing started for ${name}`);
            }
        } catch (err) {
            console.error(err);
            toast.error("An error occurred");
        }
    };

    useEffect(() => {
        fetchDataSources();
    }, []);

    return (
        <div className="h-full flex flex-col">
            <div className="flex justify-between items-center mb-6">
                <div>
                    <h1 className="text-2xl font-bold text-gray-900">Data Sources</h1>
                    <p className="text-gray-500 mt-1">Manage database connections and configurations.</p>
                </div>
                <button
                    onClick={() => setIsAddDialogOpen(true)}
                    className="flex items-center gap-2 bg-blue-600 text-white px-4 py-2 rounded-md hover:bg-blue-700 transition"
                >
                    <Plus size={18} />
                    Add Data Source
                </button>
            </div>

            <div className="bg-white rounded-lg shadow border border-gray-200 flex-1 overflow-hidden flex flex-col">
                {/* Table Header */}
                <div className="grid grid-cols-12 gap-4 p-4 border-b border-gray-200 bg-gray-50 font-medium text-sm text-gray-500">
                    <div className="col-span-4">Name</div>
                    <div className="col-span-2">Type</div>
                    <div className="col-span-2">Status</div>
                    <div className="col-span-2 text-right">Created</div>
                    <div className="col-span-2 text-right">Actions</div>
                </div>

                {/* Table Body */}
                <div className="overflow-y-auto flex-1 p-0">
                    {isLoading ? (
                        <div className="flex flex-col items-center justify-center h-64 text-gray-500">
                            <RefreshCw className="animate-spin mb-2" size={24} />
                            <p>Loading data sources...</p>
                        </div>
                    ) : dataSources.length === 0 ? (
                        <div className="flex flex-col items-center justify-center h-64 text-gray-500">
                            <Database size={48} className="mb-4 opacity-20" />
                            <p className="text-lg font-medium">No data sources found</p>
                            <p className="text-sm">Add your first database connection to get started.</p>
                            <button
                                onClick={() => setIsAddDialogOpen(true)}
                                className="mt-4 text-blue-600 hover:underline"
                            >
                                Add Data Source
                            </button>
                        </div>
                    ) : (
                        dataSources.map((ds) => (
                            <div key={ds.id} className="grid grid-cols-12 gap-4 p-4 border-b border-gray-100 hover:bg-gray-50 transition items-center">
                                <div className="col-span-4 flex items-center gap-3 font-medium text-gray-900">
                                    <div className="w-8 h-8 rounded bg-blue-100 flex items-center justify-center text-blue-600">
                                        <Database size={16} />
                                    </div>
                                    {ds.name}
                                </div>
                                <div className="col-span-2 flex items-center text-gray-600 uppercase text-xs tracking-wider">
                                    <span className="bg-gray-100 px-2 py-1 rounded">{ds.db_type}</span>
                                </div>
                                <div className="col-span-2 flex items-center">
                                    <span className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium capitalize
                     ${ds.status === 'active' ? 'bg-green-100 text-green-800' :
                                            ds.status === 'error' ? 'bg-red-100 text-red-800' : 'bg-gray-100 text-gray-800'}`}>
                                        {ds.status || 'Unknown'}
                                    </span>
                                </div>
                                <div className="col-span-2 flex items-center justify-end text-sm text-gray-500">
                                    {ds.created_at ? format(new Date(ds.created_at), 'MMM d, yyyy') : '-'}
                                </div>
                                <div className="col-span-2 flex items-center justify-end gap-2">
                                    <button
                                        onClick={(e) => {
                                            e.stopPropagation();
                                            handleIntrospect(ds);
                                        }}
                                        disabled={introspectingIds.has(ds.id)}
                                        className="text-gray-500 hover:text-blue-600 disabled:opacity-50 disabled:cursor-not-allowed"
                                        title="Introspect Schema"
                                    >
                                        <RefreshCw size={16} className={introspectingIds.has(ds.id) ? 'animate-spin text-blue-500' : ''} />
                                    </button>
                                    <button
                                        onClick={(e) => {
                                            e.stopPropagation();
                                            handleReindex(ds.id, ds.name);
                                        }}
                                        className="text-gray-500 hover:text-purple-600"
                                        title="Reindex RAG Documents"
                                    >
                                        <Sparkles size={16} />
                                    </button>
                                </div>
                            </div>
                        ))
                    )}
                </div>
            </div>

            <AddDataSourceDialog
                isOpen={isAddDialogOpen}
                onClose={() => setIsAddDialogOpen(false)}
                onSuccess={fetchDataSources}
            />
        </div>
    );
};
