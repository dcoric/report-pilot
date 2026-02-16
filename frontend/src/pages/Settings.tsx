import React, { useState, useEffect } from 'react';
import { Settings as SettingsIcon, Network, Save, AlertCircle } from 'lucide-react';
import { toast } from 'sonner';
import { client } from '../lib/api/client';

type ProviderType = 'openai' | 'gemini' | 'deepseek';
type RoutingStrategy = 'ordered_fallback' | 'cost_optimized' | 'latency_optimized';

interface RoutingRule {
    data_source_id: string;
    primary_provider: ProviderType;
    fallback_providers: ProviderType[];
    strategy: RoutingStrategy;
}

interface LlmProvider {
    provider: string;
    default_model: string;
    enabled: boolean;
}

const STRATEGIES: { id: RoutingStrategy; name: string }[] = [
    { id: 'ordered_fallback', name: 'Ordered Fallback' },
    { id: 'cost_optimized', name: 'Cost Optimized' },
    { id: 'latency_optimized', name: 'Latency Optimized' }
];

const PROVIDER_DISPLAY_NAMES: Record<string, string> = {
    openai: 'OpenAI',
    gemini: 'Google Gemini',
    deepseek: 'DeepSeek',
};

export const Settings: React.FC = () => {
    const [dataSources, setDataSources] = useState<{ id: string; name: string }[]>([]);
    const [providers, setProviders] = useState<LlmProvider[]>([]);
    const [routingRules, setRoutingRules] = useState<Record<string, RoutingRule>>({});

    useEffect(() => {
        const fetchData = async () => {
            const [dsResult, provResult] = await Promise.all([
                client.GET('/v1/data-sources'),
                client.GET('/v1/llm/providers'),
            ]);

            if (dsResult.data?.items) {
                setDataSources(dsResult.data.items.map(d => ({ id: d.id, name: d.name })));

                const initialRules: Record<string, RoutingRule> = {};
                dsResult.data.items.forEach(ds => {
                    initialRules[ds.id] = {
                        data_source_id: ds.id,
                        primary_provider: 'openai',
                        fallback_providers: [],
                        strategy: 'ordered_fallback'
                    };
                });
                setRoutingRules(initialRules);
            }

            if (provResult.data?.items) {
                setProviders(provResult.data.items);
            }
        };
        fetchData();
    }, []);

    const handleRoutingChange = <K extends keyof RoutingRule>(
        dsId: string,
        field: K,
        value: RoutingRule[K]
    ) => {
        setRoutingRules(prev => ({
            ...prev,
            [dsId]: { ...prev[dsId], [field]: value }
        }));
    };

    const saveRoutingRule = async (dsId: string) => {
        const rule = routingRules[dsId];
        try {
            const { error } = await client.POST('/v1/llm/routing-rules', {
                body: {
                    data_source_id: rule.data_source_id,
                    primary_provider: rule.primary_provider,
                    fallback_providers: rule.fallback_providers,
                    strategy: rule.strategy
                }
            });

            if (error) {
                toast.error("Failed to save routing rule");
            } else {
                toast.success("Routing rule saved");
            }
        } catch (e) {
            toast.error("An error occurred");
            console.error(e);
        }
    };

    const enabledProviders = providers.filter(p => p.enabled);

    return (
        <div className="p-8 max-w-6xl mx-auto h-full overflow-y-auto">
            <div className="flex items-center gap-3 mb-8">
                <SettingsIcon className="w-8 h-8 text-gray-700" />
                <div>
                    <h1 className="text-2xl font-bold text-gray-900">Routing Rules</h1>
                    <p className="text-gray-500 mt-1">Configure provider routing policies per data source.</p>
                </div>
            </div>

            <div className="space-y-6">
                {dataSources.map(ds => {
                    const rule = routingRules[ds.id];
                    if (!rule) return null;

                    return (
                        <div key={ds.id} className="bg-white rounded-lg border border-gray-200 shadow-sm p-6">
                            <div className="flex items-center gap-3 mb-6">
                                <div className="p-2 bg-purple-50 text-purple-600 rounded-lg">
                                    <Network size={20} />
                                </div>
                                <div>
                                    <h3 className="text-lg font-medium text-gray-900">{ds.name}</h3>
                                    <p className="text-sm text-gray-500">Routing rules for this data source</p>
                                </div>
                            </div>

                            <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
                                <div>
                                    <label className="block text-sm font-medium text-gray-700 mb-1">Primary Provider</label>
                                    <select
                                        className="block w-full rounded-md border-gray-300 shadow-sm focus:border-blue-500 focus:ring-blue-500 sm:text-sm border px-3 py-2"
                                        value={rule.primary_provider}
                                        onChange={(e) => handleRoutingChange(ds.id, 'primary_provider', e.target.value as ProviderType)}
                                    >
                                        {enabledProviders.map(p => (
                                            <option key={p.provider} value={p.provider}>{PROVIDER_DISPLAY_NAMES[p.provider] || p.provider}</option>
                                        ))}
                                    </select>
                                </div>
                                <div>
                                    <label className="block text-sm font-medium text-gray-700 mb-1">Fallback Strategy</label>
                                    <select
                                        className="block w-full rounded-md border-gray-300 shadow-sm focus:border-blue-500 focus:ring-blue-500 sm:text-sm border px-3 py-2"
                                        value={rule.strategy}
                                        onChange={(e) => handleRoutingChange(ds.id, 'strategy', e.target.value as RoutingStrategy)}
                                    >
                                        {STRATEGIES.map(s => (
                                            <option key={s.id} value={s.id}>{s.name}</option>
                                        ))}
                                    </select>
                                </div>
                                <div>
                                    <label className="block text-sm font-medium text-gray-700 mb-1">Fallback Provider(s)</label>
                                    <select
                                        className="block w-full rounded-md border-gray-300 shadow-sm focus:border-blue-500 focus:ring-blue-500 sm:text-sm border px-3 py-2"
                                        value={rule.fallback_providers[0] || ''}
                                        onChange={(e) => {
                                            const val = e.target.value as ProviderType;
                                            handleRoutingChange(ds.id, 'fallback_providers', val ? [val] : []);
                                        }}
                                    >
                                        <option value="">None</option>
                                        {enabledProviders.filter(p => p.provider !== rule.primary_provider).map(p => (
                                            <option key={p.provider} value={p.provider}>{PROVIDER_DISPLAY_NAMES[p.provider] || p.provider}</option>
                                        ))}
                                    </select>
                                </div>
                            </div>
                            <div className="mt-4 flex justify-end">
                                <button
                                    onClick={() => saveRoutingRule(ds.id)}
                                    className="flex items-center gap-2 px-4 py-2 bg-white text-gray-700 border border-gray-300 text-sm font-medium rounded-md hover:bg-gray-50 transition-colors"
                                >
                                    <Save size={16} />
                                    Save Rule
                                </button>
                            </div>
                        </div>
                    );
                })}
                {dataSources.length === 0 && (
                    <div className="text-center py-12 text-gray-500">
                        <AlertCircle className="mx-auto h-8 w-8 text-gray-400 mb-2" />
                        No data sources found. Add a data source to configure routing.
                    </div>
                )}
            </div>
        </div>
    );
};
