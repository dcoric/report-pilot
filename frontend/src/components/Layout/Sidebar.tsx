import React, { useState } from 'react';
import { Database, ChevronRight, ChevronDown } from 'lucide-react';

// Simple class utility if not exists, but package.json has clsx/tailwind-merge
// I'll check if lib/utils exists later, for now I'll use standard template.
// Actually, let's check if there is a utils file.
// I'll assume standard Shadcn-like structure or just use inline classes for MVP.

type DataSource = {
    id: string;
    name: string;
    db_type: string;
};

interface SidebarProps {
    dataSources: DataSource[];
    selectedDataSourceId: string;
    onSelectDataSource: (id: string) => void;
}

export const Sidebar: React.FC<SidebarProps> = ({ dataSources, selectedDataSourceId, onSelectDataSource }) => {
    const [isConnectionsExpanded, setIsConnectionsExpanded] = useState(true);

    return (
        <div className="w-64 bg-gray-50 border-r border-gray-200 flex flex-col h-full">
            <div className="p-4 border-b border-gray-200">
                <h1 className="font-bold text-gray-700 flex items-center gap-2">
                    <Database className="w-5 h-5 text-blue-600" />
                    AI-DB
                </h1>
            </div>

            <div className="flex-1 overflow-y-auto py-2">
                <div className="px-3 mb-1">
                    <button
                        onClick={() => setIsConnectionsExpanded(!isConnectionsExpanded)}
                        className="flex items-center gap-1 text-xs font-semibold text-gray-500 uppercase tracking-wider w-full hover:text-gray-700"
                    >
                        {isConnectionsExpanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                        Connections
                    </button>
                </div>

                {isConnectionsExpanded && (
                    <div className="space-y-0.5 px-2">
                        {dataSources.map(ds => (
                            <button
                                key={ds.id}
                                onClick={() => onSelectDataSource(ds.id)}
                                className={`w-full flex items-center gap-2 px-3 py-2 text-sm rounded-md transition-colors
                                    ${selectedDataSourceId === ds.id
                                        ? 'bg-blue-50 text-blue-700 font-medium'
                                        : 'text-gray-700 hover:bg-gray-100'}`}
                            >
                                <Database size={14} className={selectedDataSourceId === ds.id ? 'text-blue-500' : 'text-gray-400'} />
                                <span className="truncate">{ds.name}</span>
                            </button>
                        ))}
                        {dataSources.length === 0 && (
                            <div className="px-3 py-2 text-sm text-gray-400 italic">No connections</div>
                        )}
                    </div>
                )}

                {/* Placeholder for future folders/reports */}
                <div className="px-3 mt-6 mb-1">
                    <span className="flex items-center gap-1 text-xs font-semibold text-gray-400 uppercase tracking-wider">
                        Saved Reports
                    </span>
                </div>
                <div className="px-2">
                    <div className="px-3 py-2 text-sm text-gray-400 italic">Coming soon...</div>
                </div>
            </div>

            <div className="p-4 border-t border-gray-200 bg-gray-50">
                <div className="text-xs text-gray-400 text-center">v0.1.0 MVP</div>
            </div>
        </div>
    );
};
