import React, { useState, useEffect } from 'react';
import { Settings as SettingsIcon, Key, Network, Save, Server, ShieldCheck, AlertCircle } from 'lucide-react';
import { toast } from 'sonner';
import { client } from '../lib/api/client';

type ProviderType = 'openai' | 'gemini' | 'deepseek';
type RoutingStrategy = 'ordered_fallback' | 'cost_optimized' | 'latency_optimized';

interface ProviderConfig {
    provider: ProviderType;
    api_key?: string;
    default_model: string;
    enabled: boolean;
}

interface RoutingRule {
    data_source_id: string;
    primary_provider: ProviderType;
    fallback_providers: ProviderType[];
    strategy: RoutingStrategy;
}

const PROVIDERS: { id: ProviderType; name: string }[] = [
    { id: 'openai', name: 'OpenAI' },
    { id: 'gemini', name: 'Google Gemini' },
    { id: 'deepseek', name: 'DeepSeek' }
];

const STRATEGIES: { id: RoutingStrategy; name: string }[] = [
    { id: 'ordered_fallback', name: 'Ordered Fallback' },
    { id: 'cost_optimized', name: 'Cost Optimized' },
    { id: 'latency_optimized', name: 'Latency Optimized' }
];

export const Settings: React.FC = () => {
    const [activeTab, setActiveTab] = useState<'providers' | 'routing'>('providers');
    const [dataSources, setDataSources] = useState<{ id: string; name: string }[]>([]);

    // Config State
    const [providers, setProviders] = useState<Record<ProviderType, ProviderConfig>>({
        openai: { provider: 'openai', default_model: 'gpt-4o', enabled: true, api_key: '' },
        gemini: { provider: 'gemini', default_model: 'gemini-1.5-pro', enabled: false, api_key: '' },
        deepseek: { provider: 'deepseek', default_model: 'deepseek-chat', enabled: false, api_key: '' }
    });

    const [routingRules, setRoutingRules] = useState<Record<string, RoutingRule>>({});

    useEffect(() => {
        const fetchData = async () => {
            // Fetch Data Sources
            const { data: dsData } = await client.GET('/v1/data-sources');
            if (dsData?.items) {
                setDataSources(dsData.items.map(d => ({ id: d.id, name: d.name })));

                // Initialize default routing rules for each source if not exists
                // In a real app, we'd fetch existing rules from backend
                const initialRules: Record<string, RoutingRule> = {};
                dsData.items.forEach(ds => {
                    initialRules[ds.id] = {
                        data_source_id: ds.id,
                        primary_provider: 'openai',
                        fallback_providers: [],
                        strategy: 'ordered_fallback'
                    };
                });
                setRoutingRules(initialRules);
            }

            // In a real app, fetch existing provider configs here
            // const { data: providersData } = await client.GET('/v1/llm/providers'); 
        };
        fetchData();
    }, []);

    const handleProviderChange = (p: ProviderType, field: keyof ProviderConfig, value: any) => {
        setProviders(prev => ({
            ...prev,
            [p]: { ...prev[p], [field]: value }
        }));
    };

    const saveProvider = async (p: ProviderType) => {
        const config = providers[p];
        try {
            const { error } = await client.POST('/v1/llm/providers', {
                body: {
                    provider: config.provider,
                    api_key_ref: config.api_key || 'existing-key', // Mock logic for key ref
                    default_model: config.default_model,
                    enabled: config.enabled
                }
            });

            if (error) {
                toast.error(`Failed to save ${p} config`);
            } else {
                toast.success(`${p} configuration saved`);
            }
        } catch (e) {
            toast.error("An error occurred");
        }
    };

    const handleRoutingChange = (dsId: string, field: keyof RoutingRule, value: any) => {
        setRoutingRules(prev => ({
            ...prev,
            [dsId]: { ...prev[dsId], [field]: value }
        }));
    };

    const saveRoutingRule = async (dsId: string) => {
        const rule = routingRules[dsId];
        try {
            // Correctly explicitly cast the string array to the tuple type expected by the API client
            // if the API definition is strict about the tuple values
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
        }
    };

    return (
        <div className="p-8 max-w-6xl mx-auto">
            <div className="flex items-center gap-3 mb-8">
                <SettingsIcon className="w-8 h-8 text-gray-700" />
                <h1 className="text-2xl font-bold text-gray-900">Settings</h1>
            </div>

            {/* Tabs */}
            <div className="flex gap-1 border-b border-gray-200 mb-8">
                <button
                    onClick={() => setActiveTab('providers')}
                    className={`px-4 py-2 text-sm font-medium border-b-2 transition-colors flex items-center gap-2
                        ${activeTab === 'providers' ? 'border-blue-500 text-blue-600' : 'border-transparent text-gray-500 hover:text-gray-700'}`}
                >
                    <Key size={16} />
                    LLM Providers
                </button>
                <button
                    onClick={() => setActiveTab('routing')}
                    className={`px-4 py-2 text-sm font-medium border-b-2 transition-colors flex items-center gap-2
                        ${activeTab === 'routing' ? 'border-blue-500 text-blue-600' : 'border-transparent text-gray-500 hover:text-gray-700'}`}
                >
                    <Network size={16} />
                    Routing Rules
                </button>
            </div>

            {/* Providers Config */}
            {activeTab === 'providers' && (
                <div className="grid gap-6">
                    {PROVIDERS.map((p) => {
                        const config = providers[p.id];
                        return (
                            <div key={p.id} className="bg-white rounded-lg border border-gray-200 shadow-sm p-6">
                                <div className="flex items-center justify-between mb-4">
                                    <div className="flex items-center gap-3">
                                        <div className={`p-2 rounded-lg ${config.enabled ? 'bg-blue-50 text-blue-600' : 'bg-gray-100 text-gray-400'}`}>
                                            <Server size={20} />
                                        </div>
                                        <div>
                                            <h3 className="text-lg font-medium text-gray-900">{p.name}</h3>
                                            <p className="text-sm text-gray-500">Configure API access and defaults</p>
                                        </div>
                                    </div>
                                    <div className="flex items-center gap-2">
                                        <label className="relative inline-flex items-center cursor-pointer">
                                            <input
                                                type="checkbox"
                                                className="sr-only peer"
                                                checked={config.enabled}
                                                onChange={(e) => handleProviderChange(p.id, 'enabled', e.target.checked)}
                                            />
                                            <div className="w-11 h-6 bg-gray-200 peer-focus:outline-none peer-focus:ring-4 peer-focus:ring-blue-300 rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-blue-600"></div>
                                        </label>
                                    </div>
                                </div>

                                <div className={`grid grid-cols-1 md:grid-cols-2 gap-6 transition-opacity ${config.enabled ? 'opacity-100' : 'opacity-50 pointer-events-none'}`}>
                                    <div>
                                        <label className="block text-sm font-medium text-gray-700 mb-1">API Key</label>
                                        <div className="relative">
                                            <input
                                                type="password"
                                                className="block w-full rounded-md border-gray-300 shadow-sm focus:border-blue-500 focus:ring-blue-500 sm:text-sm border px-3 py-2"
                                                placeholder="sk-..."
                                                value={config.api_key}
                                                onChange={(e) => handleProviderChange(p.id, 'api_key', e.target.value)}
                                            />
                                            <ShieldCheck className="absolute right-3 top-2.5 text-gray-400" size={16} />
                                        </div>
                                    </div>
                                    <div>
                                        <label className="block text-sm font-medium text-gray-700 mb-1">Default Model</label>
                                        <input
                                            type="text"
                                            className="block w-full rounded-md border-gray-300 shadow-sm focus:border-blue-500 focus:ring-blue-500 sm:text-sm border px-3 py-2"
                                            value={config.default_model}
                                            onChange={(e) => handleProviderChange(p.id, 'default_model', e.target.value)}
                                        />
                                    </div>
                                </div>
                                <div className="mt-4 flex justify-end">
                                    <button
                                        onClick={() => saveProvider(p.id)}
                                        className="flex items-center gap-2 px-4 py-2 bg-gray-900 text-white text-sm font-medium rounded-md hover:bg-gray-800 transition-colors"
                                    >
                                        <Save size={16} />
                                        Save Config
                                    </button>
                                </div>
                            </div>
                        );
                    })}
                </div>
            )}

            {/* Routing Rules */}
            {activeTab === 'routing' && (
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
                                            {PROVIDERS.map(p => (
                                                <option key={p.id} value={p.id}>{p.name}</option>
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
                                        <div className="relative">
                                            <select
                                                className="block w-full rounded-md border-gray-300 shadow-sm focus:border-blue-500 focus:ring-blue-500 sm:text-sm border px-3 py-2"
                                                // Simple single-select fallback for MVP UI. Real UI would use multi-select
                                                value={rule.fallback_providers[0] || ''}
                                                onChange={(e) => {
                                                    const val = e.target.value as ProviderType;
                                                    handleRoutingChange(ds.id, 'fallback_providers', val ? [val] : []);
                                                }}
                                            >
                                                <option value="">None</option>
                                                {PROVIDERS.filter(p => p.id !== rule.primary_provider).map(p => (
                                                    <option key={p.id} value={p.id}>{p.name}</option>
                                                ))}
                                            </select>
                                        </div>
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
            )}
        </div>
    );
};
