import React, { useEffect, useState } from 'react';
import { Plus, Server, RefreshCw, Power, PowerOff } from 'lucide-react';
import { format } from 'date-fns';
import { toast } from 'sonner';
import { client } from '../lib/api/client';
import { AddProviderDialog } from '../components/Providers/AddProviderDialog';

interface LlmProvider {
    id: string;
    provider: string;
    default_model: string;
    enabled: boolean;
    created_at: string;
    updated_at: string;
}

interface ProviderHealth {
    provider: string;
    status: 'healthy' | 'degraded' | 'down';
    checked_at: string;
    reason?: string;
}

const PROVIDER_DISPLAY_NAMES: Record<string, string> = {
    openai: 'OpenAI',
    gemini: 'Google Gemini',
    deepseek: 'DeepSeek',
};

export const LLMProviders: React.FC = () => {
    const [providers, setProviders] = useState<LlmProvider[]>([]);
    const [healthMap, setHealthMap] = useState<Record<string, ProviderHealth>>({});
    const [isLoading, setIsLoading] = useState(true);
    const [isAddDialogOpen, setIsAddDialogOpen] = useState(false);
    const [togglingIds, setTogglingIds] = useState<Set<string>>(new Set());

    const fetchProviders = async () => {
        setIsLoading(true);
        try {
            const { data } = await client.GET('/v1/llm/providers');
            if (data?.items) {
                setProviders(data.items);
            }
        } catch (error) {
            console.error("Failed to fetch providers", error);
        } finally {
            setIsLoading(false);
        }
    };

    const fetchHealth = async () => {
        try {
            const { data } = await client.GET('/v1/health/providers');
            if (data?.items) {
                const map: Record<string, ProviderHealth> = {};
                data.items.forEach(h => { map[h.provider] = h; });
                setHealthMap(map);
            }
        } catch (error) {
            console.error("Failed to fetch provider health", error);
        }
    };

    const handleToggleEnabled = async (p: LlmProvider) => {
        if (togglingIds.has(p.id)) return;

        setTogglingIds(prev => new Set(prev).add(p.id));
        try {
            const { error } = await client.POST('/v1/llm/providers', {
                body: {
                    provider: p.provider as 'openai' | 'gemini' | 'deepseek',
                    api_key_ref: 'existing-key',
                    default_model: p.default_model,
                    enabled: !p.enabled,
                },
            });

            if (error) {
                toast.error(`Failed to update ${PROVIDER_DISPLAY_NAMES[p.provider] || p.provider}`);
            } else {
                toast.success(`${PROVIDER_DISPLAY_NAMES[p.provider] || p.provider} ${!p.enabled ? 'enabled' : 'disabled'}`);
                fetchProviders();
            }
        } catch (error) {
            console.error("Failed to toggle provider", error);
            toast.error("An error occurred");
        } finally {
            setTogglingIds(prev => {
                const next = new Set(prev);
                next.delete(p.id);
                return next;
            });
        }
    };

    useEffect(() => {
        fetchProviders();
        fetchHealth();
    }, []);

    const getHealthBadge = (provider: string) => {
        const health = healthMap[provider];
        if (!health) return null;

        const colors = {
            healthy: 'bg-green-100 text-green-800',
            degraded: 'bg-yellow-100 text-yellow-800',
            down: 'bg-red-100 text-red-800',
        };

        return (
            <span className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium capitalize ${colors[health.status]}`}>
                {health.status}
            </span>
        );
    };

    return (
        <div className="h-full flex flex-col">
            <div className="flex justify-between items-center mb-6">
                <div>
                    <h1 className="text-2xl font-bold text-gray-900">LLM Providers</h1>
                    <p className="text-gray-500 mt-1">Manage AI model providers and API configurations.</p>
                </div>
                <button
                    onClick={() => setIsAddDialogOpen(true)}
                    className="flex items-center gap-2 bg-blue-600 text-white px-4 py-2 rounded-md hover:bg-blue-700 transition"
                >
                    <Plus size={18} />
                    Add Provider
                </button>
            </div>

            <div className="bg-white rounded-lg shadow border border-gray-200 flex-1 overflow-hidden flex flex-col">
                {/* Table Header */}
                <div className="grid grid-cols-12 gap-4 p-4 border-b border-gray-200 bg-gray-50 font-medium text-sm text-gray-500">
                    <div className="col-span-3">Provider</div>
                    <div className="col-span-2">Default Model</div>
                    <div className="col-span-2">Status</div>
                    <div className="col-span-2">Health</div>
                    <div className="col-span-1 text-right">Created</div>
                    <div className="col-span-2 text-right">Actions</div>
                </div>

                {/* Table Body */}
                <div className="overflow-y-auto flex-1 p-0">
                    {isLoading ? (
                        <div className="flex flex-col items-center justify-center h-64 text-gray-500">
                            <RefreshCw className="animate-spin mb-2" size={24} />
                            <p>Loading providers...</p>
                        </div>
                    ) : providers.length === 0 ? (
                        <div className="flex flex-col items-center justify-center h-64 text-gray-500">
                            <Server size={48} className="mb-4 opacity-20" />
                            <p className="text-lg font-medium">No providers configured</p>
                            <p className="text-sm">Add your first LLM provider to get started.</p>
                            <button
                                onClick={() => setIsAddDialogOpen(true)}
                                className="mt-4 text-blue-600 hover:underline"
                            >
                                Add Provider
                            </button>
                        </div>
                    ) : (
                        providers.map((p) => (
                            <div key={p.id} className="grid grid-cols-12 gap-4 p-4 border-b border-gray-100 hover:bg-gray-50 transition items-center">
                                <div className="col-span-3 flex items-center gap-3 font-medium text-gray-900">
                                    <div className={`w-8 h-8 rounded flex items-center justify-center ${p.enabled ? 'bg-blue-100 text-blue-600' : 'bg-gray-100 text-gray-400'}`}>
                                        <Server size={16} />
                                    </div>
                                    {PROVIDER_DISPLAY_NAMES[p.provider] || p.provider}
                                </div>
                                <div className="col-span-2 flex items-center text-gray-600 text-sm">
                                    <span className="bg-gray-100 px-2 py-1 rounded font-mono text-xs">{p.default_model}</span>
                                </div>
                                <div className="col-span-2 flex items-center">
                                    <span className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium ${p.enabled ? 'bg-green-100 text-green-800' : 'bg-gray-100 text-gray-800'}`}>
                                        {p.enabled ? 'Enabled' : 'Disabled'}
                                    </span>
                                </div>
                                <div className="col-span-2 flex items-center">
                                    {getHealthBadge(p.provider)}
                                </div>
                                <div className="col-span-1 flex items-center justify-end text-sm text-gray-500">
                                    {p.created_at ? format(new Date(p.created_at), 'MMM d, yyyy') : '-'}
                                </div>
                                <div className="col-span-2 flex items-center justify-end gap-2">
                                    <button
                                        onClick={(e) => {
                                            e.stopPropagation();
                                            handleToggleEnabled(p);
                                        }}
                                        disabled={togglingIds.has(p.id)}
                                        className={`text-gray-500 disabled:opacity-50 disabled:cursor-not-allowed ${p.enabled ? 'hover:text-red-600' : 'hover:text-green-600'}`}
                                        title={p.enabled ? 'Disable provider' : 'Enable provider'}
                                    >
                                        {p.enabled ? <PowerOff size={16} /> : <Power size={16} />}
                                    </button>
                                </div>
                            </div>
                        ))
                    )}
                </div>
            </div>

            <AddProviderDialog
                isOpen={isAddDialogOpen}
                onClose={() => setIsAddDialogOpen(false)}
                onSuccess={fetchProviders}
            />
        </div>
    );
};
