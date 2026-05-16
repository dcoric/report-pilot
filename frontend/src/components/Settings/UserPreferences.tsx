import { useCallback, useEffect, useState } from 'react';
import { Save, User } from 'lucide-react';
import { toast } from 'sonner';
import { client } from '../../lib/api/client';
import type { components } from '../../lib/api/types';

type UserConfig = components['schemas']['UserConfig'];
type DataSourceSummary = { id: string; name: string };

type Theme = 'light' | 'dark' | 'system';

function pickTheme(value: unknown): Theme {
    return value === 'light' || value === 'dark' ? value : 'system';
}

export function UserPreferences({ dataSources }: { dataSources: DataSourceSummary[] }) {
    const [config, setConfig] = useState<UserConfig | null>(null);
    const [loading, setLoading] = useState(true);
    const [saving, setSaving] = useState(false);

    const fetchConfig = useCallback(async () => {
        setLoading(true);
        try {
            const { data } = await client.GET('/v1/users/me/config');
            setConfig((data && data.config) || {});
        } finally {
            setLoading(false);
        }
    }, []);

    useEffect(() => {
        void fetchConfig();
    }, [fetchConfig]);

    async function handleSave() {
        if (!config) return;
        setSaving(true);
        const body: UserConfig = {
            default_data_source_id: config.default_data_source_id ?? null,
            default_llm_provider_id: config.default_llm_provider_id ?? null,
            default_model: config.default_model ?? null,
            max_rows: config.max_rows,
            timeout_seconds: config.timeout_seconds,
            theme: pickTheme(config.theme),
            table_preferences: config.table_preferences ?? {},
        };
        const { response, data, error } = await client.PUT('/v1/users/me/config', { body });
        setSaving(false);
        if (!response.ok) {
            const msg = (error && typeof error === 'object' && 'message' in error && typeof (error as { message?: string }).message === 'string')
                ? (error as { message: string }).message
                : `Failed (${response.status}).`;
            toast.error(msg);
            return;
        }
        toast.success('Preferences saved.');
        if (data?.config) setConfig(data.config);
    }

    function patch<K extends keyof UserConfig>(key: K, value: UserConfig[K]) {
        setConfig((prev) => ({ ...(prev || {}), [key]: value }));
    }

    return (
        <div className="bg-white rounded-lg border border-gray-200 shadow-sm p-6">
            <div className="flex items-center gap-3 mb-6">
                <div className="p-2 bg-blue-50 text-blue-600 rounded-lg">
                    <User size={20} />
                </div>
                <div>
                    <h3 className="text-lg font-medium text-gray-900">Your preferences</h3>
                    <p className="text-sm text-gray-500">Defaults applied when you open the query workspace.</p>
                </div>
            </div>

            {loading || !config ? (
                <p className="text-sm text-gray-500">Loading…</p>
            ) : (
                <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                    <div>
                        <label className="block text-sm font-medium text-gray-700 mb-1">Default data source</label>
                        <select
                            className="block w-full rounded-md border-gray-300 shadow-sm focus:border-oxblood focus:ring-oxblood sm:text-sm border px-3 py-2"
                            value={config.default_data_source_id || ''}
                            onChange={(e) => patch('default_data_source_id', e.target.value || null)}
                        >
                            <option value="">No preference</option>
                            {dataSources.map((ds) => (
                                <option key={ds.id} value={ds.id}>{ds.name}</option>
                            ))}
                        </select>
                    </div>
                    <div>
                        <label className="block text-sm font-medium text-gray-700 mb-1">Theme</label>
                        <select
                            className="block w-full rounded-md border-gray-300 shadow-sm focus:border-oxblood focus:ring-oxblood sm:text-sm border px-3 py-2"
                            value={pickTheme(config.theme)}
                            onChange={(e) => patch('theme', e.target.value as Theme)}
                        >
                            <option value="system">System</option>
                            <option value="light">Light</option>
                            <option value="dark">Dark</option>
                        </select>
                    </div>
                    <div>
                        <label className="block text-sm font-medium text-gray-700 mb-1">Default row limit</label>
                        <input
                            type="number"
                            min={1}
                            max={10000}
                            value={config.max_rows ?? 1000}
                            onChange={(e) => patch('max_rows', Number(e.target.value))}
                            className="block w-full rounded-md border-gray-300 shadow-sm focus:border-oxblood focus:ring-oxblood sm:text-sm border px-3 py-2"
                        />
                        <p className="mt-1 text-xs text-gray-500">1–10000.</p>
                    </div>
                    <div>
                        <label className="block text-sm font-medium text-gray-700 mb-1">Query timeout (seconds)</label>
                        <input
                            type="number"
                            min={1}
                            max={300}
                            value={config.timeout_seconds ?? 30}
                            onChange={(e) => patch('timeout_seconds', Number(e.target.value))}
                            className="block w-full rounded-md border-gray-300 shadow-sm focus:border-oxblood focus:ring-oxblood sm:text-sm border px-3 py-2"
                        />
                        <p className="mt-1 text-xs text-gray-500">1–300.</p>
                    </div>
                </div>
            )}

            <div className="mt-6 flex justify-end">
                <button
                    type="button"
                    onClick={() => void handleSave()}
                    disabled={saving || loading || !config}
                    className="flex items-center gap-2 px-4 py-2 bg-oxblood text-white text-sm font-medium rounded-md hover:bg-oxblood-deep disabled:opacity-60"
                >
                    <Save size={16} />
                    {saving ? 'Saving…' : 'Save preferences'}
                </button>
            </div>
        </div>
    );
}
