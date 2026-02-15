import React, { useState } from 'react';
import { Database, ChevronRight, ChevronDown, Table, FolderClosed, Plus } from 'lucide-react';
import { client } from '../../lib/api/client';
import type { components } from '../../lib/api/types';

type DataSource = {
    id: string;
    name: string;
    db_type: string;
};

type SchemaObject = components['schemas']['SchemaObject'];

interface SidebarProps {
    dataSources: DataSource[];
    selectedDataSourceId: string;
    onSelectDataSource: (id: string) => void;
}

export const Sidebar: React.FC<SidebarProps> = ({
    dataSources,
    selectedDataSourceId,
    onSelectDataSource
}) => {
    const [isConnectionsExpanded, setIsConnectionsExpanded] = useState(true);
    const [isSavedReportsExpanded, setIsSavedReportsExpanded] = useState(true);
    const [expandedConnections, setExpandedConnections] = useState<Set<string>>(new Set());
    const [connectionSchemas, setConnectionSchemas] = useState<Record<string, SchemaObject[]>>({});
    const [loadingSchemas, setLoadingSchemas] = useState<Set<string>>(new Set());

    // Load schemas when a connection is expanded
    const toggleConnection = async (connectionId: string) => {
        const newExpanded = new Set(expandedConnections);

        if (newExpanded.has(connectionId)) {
            newExpanded.delete(connectionId);
        } else {
            newExpanded.add(connectionId);

            // Fetch schemas if not already loaded
            if (!connectionSchemas[connectionId]) {
                setLoadingSchemas(prev => new Set(prev).add(connectionId));
                try {
                    const { data } = await client.GET('/v1/schema-objects', {
                        params: { query: { data_source_id: connectionId } }
                    });

                    if (data?.items) {
                        setConnectionSchemas(prev => ({
                            ...prev,
                            [connectionId]: data.items || []
                        }));
                    }
                } catch (error) {
                    console.error('Failed to load schemas:', error);
                } finally {
                    setLoadingSchemas(prev => {
                        const next = new Set(prev);
                        next.delete(connectionId);
                        return next;
                    });
                }
            }
        }

        setExpandedConnections(newExpanded);
    };

    // Group schema objects by schema name
    const groupBySchema = (objects: SchemaObject[]) => {
        const groups: Record<string, SchemaObject[]> = {};
        objects.forEach(obj => {
            const schema = obj.schema_name || 'public';
            if (!groups[schema]) groups[schema] = [];
            groups[schema].push(obj);
        });
        return groups;
    };

    return (
        <div className="w-64 bg-gray-50 border-r border-gray-200 flex flex-col h-full">
            {/* Connections Section */}
            <div className="flex-1 overflow-y-auto py-2">
                {/* Connections Header */}
                <div className="px-3 mb-1">
                    <button
                        onClick={() => setIsConnectionsExpanded(!isConnectionsExpanded)}
                        className="flex items-center gap-1 text-xs font-semibold text-gray-500 uppercase tracking-wider w-full hover:text-gray-700"
                    >
                        {isConnectionsExpanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                        Connections
                    </button>
                </div>

                {/* Connections List */}
                {isConnectionsExpanded && (
                    <div className="space-y-0.5 px-2 mb-4">
                        {dataSources.map(ds => (
                            <div key={ds.id}>
                                {/* Connection Node */}
                                <div className="flex items-center">
                                    <button
                                        onClick={() => toggleConnection(ds.id)}
                                        className="p-1 hover:bg-gray-100 rounded"
                                    >
                                        {expandedConnections.has(ds.id) ?
                                            <ChevronDown size={14} className="text-gray-400" /> :
                                            <ChevronRight size={14} className="text-gray-400" />
                                        }
                                    </button>
                                    <button
                                        onClick={() => onSelectDataSource(ds.id)}
                                        className={`flex-1 flex items-center gap-2 px-2 py-1.5 text-sm rounded-md transition-colors ${
                                            selectedDataSourceId === ds.id
                                                ? 'bg-blue-50 text-blue-700 font-medium'
                                                : 'text-gray-700 hover:bg-gray-100'
                                        }`}
                                    >
                                        <Database size={14} className={selectedDataSourceId === ds.id ? 'text-blue-500' : 'text-gray-400'} />
                                        <span className="truncate">{ds.name}</span>
                                    </button>
                                </div>

                                {/* Expanded Schema/Tables */}
                                {expandedConnections.has(ds.id) && (
                                    <div className="ml-5 mt-1 space-y-0.5">
                                        {loadingSchemas.has(ds.id) ? (
                                            <div className="px-3 py-1 text-xs text-gray-400 italic">Loading...</div>
                                        ) : connectionSchemas[ds.id] ? (
                                            Object.entries(groupBySchema(connectionSchemas[ds.id])).map(([schemaName, objects]) => (
                                                <div key={schemaName} className="mb-2">
                                                    <div className="px-2 py-1 text-xs font-semibold text-gray-500 uppercase tracking-wider">
                                                        {schemaName}
                                                    </div>
                                                    <div className="space-y-0.5">
                                                        {objects.slice(0, 10).map(obj => (
                                                            <div
                                                                key={obj.id}
                                                                className="flex items-center gap-2 px-2 py-1 text-xs text-gray-600 hover:bg-gray-100 rounded cursor-pointer"
                                                                title={obj.description || obj.object_name}
                                                            >
                                                                <Table size={12} className="text-gray-400 flex-shrink-0" />
                                                                <span className="truncate">{obj.object_name}</span>
                                                            </div>
                                                        ))}
                                                        {objects.length > 10 && (
                                                            <div className="px-2 py-1 text-xs text-gray-400 italic">
                                                                +{objects.length - 10} more
                                                            </div>
                                                        )}
                                                    </div>
                                                </div>
                                            ))
                                        ) : (
                                            <div className="px-3 py-1 text-xs text-gray-400 italic">No schemas found</div>
                                        )}
                                    </div>
                                )}
                            </div>
                        ))}
                        {dataSources.length === 0 && (
                            <div className="px-3 py-2 text-sm text-gray-400 italic">No connections</div>
                        )}
                    </div>
                )}

                {/* Saved Reports Section */}
                <div className="px-3 mb-1">
                    <button
                        onClick={() => setIsSavedReportsExpanded(!isSavedReportsExpanded)}
                        className="flex items-center gap-1 text-xs font-semibold text-gray-500 uppercase tracking-wider w-full hover:text-gray-700"
                    >
                        {isSavedReportsExpanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                        Saved Reports
                    </button>
                </div>

                {isSavedReportsExpanded && (
                    <div className="space-y-0.5 px-2">
                        {/* Example folders - replace with actual data */}
                        <div className="ml-3">
                            <div className="flex items-center gap-2 px-2 py-1 text-sm text-gray-600 hover:bg-gray-100 rounded cursor-pointer">
                                <FolderClosed size={14} className="text-gray-400" />
                                <span>Finance</span>
                            </div>
                            <div className="flex items-center gap-2 px-2 py-1 text-sm text-gray-600 hover:bg-gray-100 rounded cursor-pointer">
                                <FolderClosed size={14} className="text-gray-400" />
                                <span>Marketing</span>
                            </div>
                            <div className="px-3 py-2 text-sm text-gray-400 italic">Coming soon...</div>
                        </div>
                    </div>
                )}
            </div>

            {/* Action Buttons */}
            <div className="p-3 border-t border-gray-200 bg-gray-50 space-y-2">
                <button className="w-full flex items-center justify-center gap-2 px-3 py-2 text-sm font-medium text-gray-700 bg-white border border-gray-300 rounded-md hover:bg-gray-50">
                    <Plus size={14} />
                    New Folder
                </button>
                <button className="w-full flex items-center justify-center gap-2 px-3 py-2 text-sm font-medium text-white bg-blue-600 rounded-md hover:bg-blue-700">
                    <Plus size={14} />
                    Save Current Report
                </button>
            </div>
        </div>
    );
};
