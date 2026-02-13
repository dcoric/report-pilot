import React, { useState } from 'react';
import { Table as TableIcon, Eye, Search, Sparkles } from 'lucide-react';
import type { components } from '../../lib/api/types';
import { SemanticEditorDialog } from '../../components/Semantic/SemanticEditorDialog';

type SchemaObject = components['schemas']['SchemaObject'];

interface SchemaObjectListProps {
    objects: SchemaObject[];
    filter: string;
    dataSourceId: string;
}

export const SchemaObjectList: React.FC<SchemaObjectListProps> = ({ objects, filter, dataSourceId }) => {
    const [selectedObject, setSelectedObject] = useState<SchemaObject | null>(null);
    const [isDialogOpen, setIsDialogOpen] = useState(false);

    const filteredObjects = objects.filter(obj =>
        obj.object_name.toLowerCase().includes(filter.toLowerCase()) ||
        obj.schema_name.toLowerCase().includes(filter.toLowerCase())
    );

    const handleEnrich = (obj: SchemaObject) => {
        setSelectedObject(obj);
        setIsDialogOpen(true);
    };

    if (filteredObjects.length === 0) {
        return (
            <div className="flex flex-col items-center justify-center h-64 text-gray-400">
                <Search size={48} className="mb-4 opacity-20" />
                <p>No objects found matching "{filter}"</p>
            </div>
        );
    }

    return (
        <>
            <div className="bg-white rounded-lg shadow overflow-hidden border border-gray-200">
                <table className="min-w-full divide-y divide-gray-200">
                    <thead className="bg-gray-50">
                        <tr>
                            <th scope="col" className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Type</th>
                            <th scope="col" className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Schema</th>
                            <th scope="col" className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Name</th>
                            <th scope="col" className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Description</th>
                            <th scope="col" className="px-6 py-3 text-right text-xs font-medium text-gray-500 uppercase tracking-wider">Actions</th>
                        </tr>
                    </thead>
                    <tbody className="bg-white divide-y divide-gray-200">
                        {filteredObjects.map((obj) => (
                            <tr key={obj.id} className="hover:bg-gray-50 group">
                                <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-500">
                                    <div className="flex items-center" title={obj.object_type}>
                                        {obj.object_type === 'view' || obj.object_type === 'materialized_view' ? (
                                            <Eye size={16} className="text-purple-500" />
                                        ) : (
                                            <TableIcon size={16} className="text-blue-500" />
                                        )}
                                        <span className="ml-2 capitalize text-xs bg-gray-100 rounded px-1.5 py-0.5">{obj.object_type.replace('_', ' ')}</span>
                                    </div>
                                </td>
                                <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-900 font-medium">{obj.schema_name}</td>
                                <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-900">{obj.object_name}</td>
                                <td className="px-6 py-4 text-sm text-gray-500 max-w-md truncate" title={obj.description || ''}>
                                    {obj.description || '-'}
                                </td>
                                <td className="px-6 py-4 whitespace-nowrap text-right text-sm font-medium">
                                    <button
                                        onClick={() => handleEnrich(obj)}
                                        className="text-blue-600 hover:text-blue-900 flex items-center gap-1 ml-auto opacity-0 group-hover:opacity-100 transition-opacity"
                                    >
                                        <Sparkles size={14} />
                                        Enrich
                                    </button>
                                </td>
                            </tr>
                        ))}
                    </tbody>
                </table>
            </div>

            <SemanticEditorDialog
                isOpen={isDialogOpen}
                onClose={() => setIsDialogOpen(false)}
                schemaObject={selectedObject}
                dataSourceId={dataSourceId}
            />
        </>
    );
};
