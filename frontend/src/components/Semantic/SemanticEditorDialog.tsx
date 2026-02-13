import React, { useState, useEffect } from 'react';
import { X, Save, Database, Ruler } from 'lucide-react';
import { toast } from 'sonner';
import { client } from '../../lib/api/client';
import type { components } from '../../lib/api/types';

type SchemaObject = components['schemas']['SchemaObject'];
type SemanticEntityType = components['schemas']['SemanticEntityRequest']['entity_type'];

interface SemanticEditorDialogProps {
    isOpen: boolean;
    onClose: () => void;
    schemaObject: SchemaObject | null;
    dataSourceId: string;
}

export const SemanticEditorDialog: React.FC<SemanticEditorDialogProps> = ({
    isOpen,
    onClose,
    schemaObject,
    dataSourceId,
}) => {
    const [activeTab, setActiveTab] = useState<'entity' | 'metric'>('entity');
    const [semanticEntityId, setSemanticEntityId] = useState<string | null>(null);
    const [isSubmitting, setIsSubmitting] = useState(false);

    // Entity Form State
    const [entityType, setEntityType] = useState<SemanticEntityType>('table');
    const [businessName, setBusinessName] = useState('');
    const [description, setDescription] = useState('');

    // Metric Form State
    const [sqlExpression, setSqlExpression] = useState('');
    const [grain, setGrain] = useState('');

    // Reset or pre-fill when opening for a new object
    useEffect(() => {
        if (isOpen && schemaObject) {
            setEntityType(schemaObject.object_type === 'view' ? 'table' : 'table'); // Default mapping
            setBusinessName(schemaObject.object_name.replace(/_/g, ' '));
            setDescription(schemaObject.description || '');
            setSemanticEntityId(null); // Reset ID
            setSqlExpression('');
            setGrain('');
            setActiveTab('entity');
        }
    }, [isOpen, schemaObject]);

    if (!isOpen || !schemaObject) return null;

    const handleEntitySubmit = async (e: React.FormEvent) => {
        e.preventDefault();
        setIsSubmitting(true);
        try {
            const { data, error } = await client.POST('/v1/semantic-entities', {
                body: {
                    data_source_id: dataSourceId,
                    entity_type: entityType,
                    target_ref: `${schemaObject.schema_name}.${schemaObject.object_name}`,
                    business_name: businessName,
                    description: description,
                }
            });

            if (error) {
                console.error("Entity save failed", error);
            } else if (data) {
                setSemanticEntityId(data.id);
                toast.success("Semantic entity saved");
            }
        } catch (err) {
            console.error("Unexpected error", err);
        } finally {
            setIsSubmitting(false);
        }
    };

    const handleMetricSubmit = async (e: React.FormEvent) => {
        e.preventDefault();
        if (!semanticEntityId) {
            toast.error("Please save the semantic entity first.");
            return;
        }
        setIsSubmitting(true);
        try {
            const { data, error } = await client.POST('/v1/metric-definitions', {
                body: {
                    semantic_entity_id: semanticEntityId,
                    sql_expression: sqlExpression,
                    grain: grain || undefined,
                }
            });

            if (error) {
                console.error("Metric save failed", error);
            } else if (data) {
                toast.success("Metric definition saved");
                onClose();
            }
        } catch (err) {
            console.error("Unexpected error", err);
        } finally {
            setIsSubmitting(false);
        }
    };

    return (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black bg-opacity-50">
            <div className="bg-white rounded-lg shadow-xl w-full max-w-2xl overflow-hidden flex flex-col max-h-[90vh]">
                {/* Header */}
                <div className="flex justify-between items-center p-4 border-b">
                    <div>
                        <h2 className="text-lg font-semibold">Enrich Context</h2>
                        <p className="text-sm text-gray-500">
                            {schemaObject.schema_name}.{schemaObject.object_name}
                        </p>
                    </div>
                    <button onClick={onClose} className="text-gray-500 hover:text-gray-700">
                        <X size={20} />
                    </button>
                </div>

                {/* Tabs */}
                <div className="flex border-b bg-gray-50">
                    <button
                        className={`flex-1 py-3 px-4 text-sm font-medium flex items-center justify-center gap-2 border-b-2 transition-colors
              ${activeTab === 'entity' ? 'border-blue-500 text-blue-600 bg-white' : 'border-transparent text-gray-500 hover:text-gray-700'}`}
                        onClick={() => setActiveTab('entity')}
                    >
                        <Database size={16} />
                        Semantic Entity
                    </button>
                    <button
                        className={`flex-1 py-3 px-4 text-sm font-medium flex items-center justify-center gap-2 border-b-2 transition-colors
              ${activeTab === 'metric' ? 'border-purple-500 text-purple-600 bg-white' : 'border-transparent text-gray-500 hover:text-gray-700'}`}
                        onClick={() => setActiveTab('metric')}
                        disabled={!semanticEntityId}
                        title={!semanticEntityId ? "Save entity first to add metrics" : ""}
                    >
                        <Ruler size={16} />
                        Metric Definition
                        {!semanticEntityId && <span className="text-xs ml-1 opacity-50">(Locked)</span>}
                    </button>
                </div>

                {/* Content */}
                <div className="p-6 overflow-y-auto flex-1">
                    {activeTab === 'entity' ? (
                        <form id="entity-form" onSubmit={handleEntitySubmit} className="flex flex-col gap-4">
                            <div className="grid grid-cols-2 gap-4">
                                <div>
                                    <label className="block text-sm font-medium text-gray-700 mb-1">Entity Type</label>
                                    <select
                                        className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                                        value={entityType}
                                        onChange={(e) => setEntityType(e.target.value as SemanticEntityType)}
                                    >
                                        <option value="table">Table</option>
                                        <option value="column">Column</option>
                                        <option value="metric">Metric</option>
                                        <option value="dimension">Dimension</option>
                                    </select>
                                </div>
                                <div>
                                    <label className="block text-sm font-medium text-gray-700 mb-1">Target Ref</label>
                                    <input
                                        type="text"
                                        className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm bg-gray-100 text-gray-500 cursor-not-allowed"
                                        value={`${schemaObject.schema_name}.${schemaObject.object_name}`}
                                        disabled
                                    />
                                </div>
                            </div>

                            <div>
                                <label className="block text-sm font-medium text-gray-700 mb-1">Business Name</label>
                                <input
                                    type="text"
                                    required
                                    className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                                    value={businessName}
                                    onChange={(e) => setBusinessName(e.target.value)}
                                    placeholder="e.g. Daily Active Users"
                                />
                            </div>

                            <div>
                                <label className="block text-sm font-medium text-gray-700 mb-1">Description</label>
                                <textarea
                                    rows={4}
                                    className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                                    value={description}
                                    onChange={(e) => setDescription(e.target.value)}
                                    placeholder="Describe what this entity represents..."
                                />
                            </div>
                        </form>
                    ) : (
                        <form id="metric-form" onSubmit={handleMetricSubmit} className="flex flex-col gap-4">
                            <div className="bg-blue-50 border border-blue-100 p-3 rounded-md mb-2">
                                <p className="text-sm text-blue-800">
                                    <strong>Entity ID:</strong> {semanticEntityId}
                                </p>
                            </div>

                            <div>
                                <label className="block text-sm font-medium text-gray-700 mb-1">SQL Expression</label>
                                <textarea
                                    required
                                    rows={4}
                                    className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-purple-500"
                                    value={sqlExpression}
                                    onChange={(e) => setSqlExpression(e.target.value)}
                                    placeholder="e.g. SUM(amount) * 1.2"
                                />
                                <p className="text-xs text-gray-500 mt-1">Valid SQL snippet aggregating the underlying table.</p>
                            </div>

                            <div>
                                <label className="block text-sm font-medium text-gray-700 mb-1">Grain (Optional)</label>
                                <input
                                    type="text"
                                    className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-purple-500"
                                    value={grain}
                                    onChange={(e) => setGrain(e.target.value)}
                                    placeholder="e.g. daily, user_id"
                                />
                            </div>
                        </form>
                    )}
                </div>

                {/* Footer */}
                <div className="p-4 border-t bg-gray-50 flex justify-end gap-2">
                    <button
                        type="button"
                        onClick={onClose}
                        className="px-4 py-2 text-sm font-medium text-gray-700 bg-white border border-gray-300 rounded-md hover:bg-gray-50"
                    >
                        Close
                    </button>
                    <button
                        type="submit"
                        form={activeTab === 'entity' ? 'entity-form' : 'metric-form'}
                        className={`px-4 py-2 text-sm font-medium text-white rounded-md flex items-center gap-2
                    ${activeTab === 'entity'
                                ? 'bg-blue-600 hover:bg-blue-700'
                                : 'bg-purple-600 hover:bg-purple-700'}`}
                        disabled={isSubmitting}
                    >
                        <Save size={16} />
                        {isSubmitting ? 'Saving...' : `Save ${activeTab === 'entity' ? 'Entity' : 'Metric'}`}
                    </button>
                </div>
            </div>
        </div>
    );
};
