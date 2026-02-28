import React, { useEffect, useState } from 'react';
import { Table as TableIcon, Eye, EyeOff, Search, Sparkles } from 'lucide-react';
import type { components } from '../../lib/api/types';
import { SemanticEditorDialog } from '../../components/Semantic/SemanticEditorDialog';
import { client } from '../../lib/api/client';
import { toast } from 'sonner';

type SchemaObject = components['schemas']['SchemaObject'];

interface SchemaObjectListProps {
    objects: SchemaObject[];
    filter: string;
    dataSourceId: string;
}

export const SchemaObjectList: React.FC<SchemaObjectListProps> = ({ objects, filter, dataSourceId }) => {
    const [selectedObject, setSelectedObject] = useState<SchemaObject | null>(null);
    const [isDialogOpen, setIsDialogOpen] = useState(false);
    const [localObjects, setLocalObjects] = useState<SchemaObject[]>(objects);
    const [pendingIds, setPendingIds] = useState<Set<string>>(new Set());

    useEffect(() => {
        setLocalObjects(objects);
    }, [objects]);

    const filteredObjects = localObjects.filter(obj =>
        obj.object_name.toLowerCase().includes(filter.toLowerCase()) ||
        obj.schema_name.toLowerCase().includes(filter.toLowerCase())
    );

    const handleEnrich = (obj: SchemaObject) => {
        setSelectedObject(obj);
        setIsDialogOpen(true);
    };

    const handleToggleIgnored = async (obj: SchemaObject) => {
        if (pendingIds.has(obj.id)) {
            return;
        }

        const nextIgnoredState = !Boolean(obj.is_ignored);
        setPendingIds((prev) => new Set(prev).add(obj.id));
        setLocalObjects((prev) => prev.map((item) => (
            item.id === obj.id ? { ...item, is_ignored: nextIgnoredState } : item
        )));

        try {
            const { error } = await client.PATCH('/v1/schema-objects/{schemaObjectId}', {
                params: { path: { schemaObjectId: obj.id } },
                body: { is_ignored: nextIgnoredState },
            });

            if (error) {
                throw new Error('Failed to update schema object visibility');
            }

            toast.success(
                nextIgnoredState
                    ? `Hidden ${obj.schema_name}.${obj.object_name} from query context`
                    : `Enabled ${obj.schema_name}.${obj.object_name} for query context`
            );
        } catch (error) {
            console.error(error);
            setLocalObjects((prev) => prev.map((item) => (
                item.id === obj.id ? { ...item, is_ignored: Boolean(obj.is_ignored) } : item
            )));
            toast.error('Failed to update schema object visibility');
        } finally {
            setPendingIds((prev) => {
                const next = new Set(prev);
                next.delete(obj.id);
                return next;
            });
        }
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
                            <tr key={obj.id} className={`hover:bg-gray-50 group ${obj.is_ignored ? 'bg-red-50/50' : ''}`}>
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
                                    <div className="flex items-center justify-end gap-3">
                                        <button
                                            onClick={() => handleToggleIgnored(obj)}
                                            disabled={pendingIds.has(obj.id)}
                                            className={`disabled:opacity-50 ${obj.is_ignored ? 'text-red-600 hover:text-red-700' : 'text-gray-500 hover:text-blue-600'}`}
                                            title={obj.is_ignored ? 'Hidden from queries (click to enable)' : 'Visible to queries (click to hide)'}
                                            aria-label={obj.is_ignored ? `Enable ${obj.schema_name}.${obj.object_name}` : `Hide ${obj.schema_name}.${obj.object_name}`}
                                        >
                                            {obj.is_ignored ? <EyeOff size={16} /> : <Eye size={16} />}
                                        </button>
                                        <button
                                            onClick={() => handleEnrich(obj)}
                                            className="text-blue-600 hover:text-blue-900 flex items-center gap-1"
                                        >
                                            <Sparkles size={14} />
                                            Enrich
                                        </button>
                                    </div>
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
