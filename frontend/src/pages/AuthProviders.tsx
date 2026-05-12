import { useCallback, useEffect, useMemo, useState } from 'react';
import { CheckCircle2, KeyRound, Plus, RefreshCw, ShieldAlert, Trash2, XCircle } from 'lucide-react';
import { format } from 'date-fns';
import { toast } from 'sonner';
import { client } from '../lib/api/client';
import { AuthProviderDialog, type AuthProvider, type AuthProviderFormValues } from '../components/Admin/AuthProviderDialog';

type TestState = {
    ok: boolean | null;
    error?: string;
    issuer?: string;
    at?: string;
    running?: boolean;
};

function defaultRedirectUri(): string {
    if (typeof window === 'undefined') return '';
    return `${window.location.origin}/v1/auth/oidc/callback`;
}

export function AuthProviders() {
    const [items, setItems] = useState<AuthProvider[]>([]);
    const [isLoading, setIsLoading] = useState(true);
    const [dialogOpen, setDialogOpen] = useState(false);
    const [editing, setEditing] = useState<AuthProvider | null>(null);
    const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
    const [tests, setTests] = useState<Record<string, TestState>>({});

    const fetchProviders = useCallback(async () => {
        setIsLoading(true);
        try {
            const { data } = await client.GET('/v1/admin/auth-providers');
            setItems(data?.items ?? []);
        } finally {
            setIsLoading(false);
        }
    }, []);

    useEffect(() => {
        void fetchProviders();
    }, [fetchProviders]);

    const redirectUri = useMemo(() => defaultRedirectUri(), []);

    async function handleSubmit(values: AuthProviderFormValues): Promise<{ ok: boolean; message?: string }> {
        const { id, ...rest } = values;
        const body = id ? { id, ...rest } : rest;
        const { response, data, error } = await client.POST('/v1/admin/auth-providers', { body });
        if (response.ok) {
            toast.success(id ? 'Provider updated.' : 'Provider created.');
            setDialogOpen(false);
            setEditing(null);
            await fetchProviders();
            if (data && 'id' in data && typeof data.id === 'string') {
                setTests((prev) => ({ ...prev, [data.id as string]: { ok: null } }));
            }
            return { ok: true };
        }
        let message = `Failed (${response.status}).`;
        if (error && typeof error === 'object' && 'message' in error && typeof (error as { message?: string }).message === 'string') {
            message = (error as { message: string }).message;
        }
        return { ok: false, message };
    }

    async function handleDelete(id: string) {
        const { response } = await client.DELETE('/v1/admin/auth-providers/{providerId}', {
            params: { path: { providerId: id } },
        });
        if (response.ok) {
            toast.success('Provider deleted.');
            await fetchProviders();
        } else {
            toast.error('Failed to delete provider.');
        }
        setConfirmDeleteId(null);
    }

    async function handleTest(provider: AuthProvider) {
        if (!provider.id) return;
        setTests((prev) => ({ ...prev, [provider.id as string]: { ...(prev[provider.id as string] || { ok: null }), running: true } }));
        const { data, response } = await client.POST(
            '/v1/admin/auth-providers/{providerId}/test',
            { params: { path: { providerId: provider.id } } },
        );
        if (!response.ok || !data) {
            setTests((prev) => ({
                ...prev,
                [provider.id as string]: { ok: false, error: `HTTP ${response.status}`, at: new Date().toISOString() },
            }));
            return;
        }
        setTests((prev) => ({
            ...prev,
            [provider.id as string]: {
                ok: Boolean(data.ok),
                error: data.ok ? undefined : data.error ?? 'Test failed.',
                issuer: data.issuer,
                at: new Date().toISOString(),
            },
        }));
    }

    return (
        <div className="flex h-full flex-col p-6">
            <div className="mb-6 flex items-start justify-between">
                <div>
                    <h1 className="text-2xl font-bold text-gray-900">Auth Providers</h1>
                    <p className="mt-1 text-sm text-gray-500">
                        Configure OIDC identity providers that appear on the login page.
                    </p>
                </div>
                <button
                    type="button"
                    onClick={() => { setEditing(null); setDialogOpen(true); }}
                    className="flex items-center gap-2 rounded-md bg-oxblood px-4 py-2 text-sm font-medium text-white hover:bg-oxblood-deep"
                >
                    <Plus size={16} />
                    Add provider
                </button>
            </div>

            <div className="flex-1 overflow-hidden rounded-lg border border-gray-200 bg-white shadow-sm">
                <div className="grid grid-cols-12 gap-4 border-b border-gray-200 bg-gray-50 px-4 py-3 text-xs font-medium uppercase tracking-wider text-gray-500">
                    <div className="col-span-3">Provider</div>
                    <div className="col-span-3">Issuer</div>
                    <div className="col-span-2">Status</div>
                    <div className="col-span-2">Health</div>
                    <div className="col-span-2 text-right">Actions</div>
                </div>

                <div className="h-full overflow-y-auto">
                    {isLoading ? (
                        <div className="flex h-64 flex-col items-center justify-center text-gray-500">
                            <RefreshCw className="mb-2 animate-spin" size={20} />
                            <p>Loading…</p>
                        </div>
                    ) : items.length === 0 ? (
                        <div className="flex h-64 flex-col items-center justify-center text-gray-500">
                            <KeyRound size={40} className="mb-3 opacity-30" />
                            <p className="text-sm font-medium">No auth providers configured</p>
                            <p className="mt-1 text-xs">Add your first OIDC provider to enable SSO on the login page.</p>
                        </div>
                    ) : (
                        items.map((provider) => {
                            const t = provider.id ? tests[provider.id] : undefined;
                            return (
                                <div key={provider.id} className="grid grid-cols-12 items-center gap-4 border-b border-gray-100 px-4 py-3 text-sm">
                                    <div className="col-span-3">
                                        <div className="font-medium text-gray-900">{provider.display_name || provider.name}</div>
                                        <div className="text-xs text-gray-500">{provider.name} · {(provider.type || 'oidc').toUpperCase()}</div>
                                    </div>
                                    <div className="col-span-3 truncate text-xs text-gray-600" title={provider.issuer}>
                                        {provider.issuer}
                                    </div>
                                    <div className="col-span-2">
                                        <span
                                            className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${
                                                provider.enabled ? 'bg-green-100 text-green-800' : 'bg-gray-100 text-gray-700'
                                            }`}
                                        >
                                            {provider.enabled ? 'Enabled' : 'Disabled'}
                                        </span>
                                    </div>
                                    <div className="col-span-2 text-xs">
                                        {t?.running ? (
                                            <span className="inline-flex items-center gap-1 text-gray-500">
                                                <RefreshCw size={12} className="animate-spin" />
                                                Testing…
                                            </span>
                                        ) : t?.ok === true ? (
                                            <span className="inline-flex items-center gap-1 text-green-700">
                                                <CheckCircle2 size={12} />
                                                Reachable
                                            </span>
                                        ) : t?.ok === false ? (
                                            <span className="inline-flex items-center gap-1 text-red-700" title={t.error}>
                                                <XCircle size={12} />
                                                Failed
                                            </span>
                                        ) : (
                                            <span className="text-gray-400">Not tested</span>
                                        )}
                                        {t?.at && (
                                            <div className="text-[10px] text-gray-400">{format(new Date(t.at), 'HH:mm:ss')}</div>
                                        )}
                                    </div>
                                    <div className="col-span-2 flex items-center justify-end gap-2">
                                        <button
                                            type="button"
                                            onClick={() => handleTest(provider)}
                                            className="rounded px-2 py-1 text-xs text-gray-600 hover:bg-gray-100"
                                            title="Run OIDC discovery against the issuer"
                                        >
                                            Test
                                        </button>
                                        <button
                                            type="button"
                                            onClick={() => { setEditing(provider); setDialogOpen(true); }}
                                            className="rounded px-2 py-1 text-xs text-oxblood hover:bg-oxblood/10"
                                        >
                                            Edit
                                        </button>
                                        {confirmDeleteId === provider.id ? (
                                            <span className="flex items-center gap-1">
                                                <button
                                                    type="button"
                                                    onClick={() => provider.id && handleDelete(provider.id)}
                                                    className="rounded bg-red-600 px-2 py-1 text-xs text-white hover:bg-red-700"
                                                >
                                                    Confirm
                                                </button>
                                                <button
                                                    type="button"
                                                    onClick={() => setConfirmDeleteId(null)}
                                                    className="px-1 text-xs text-gray-500 hover:text-gray-700"
                                                >
                                                    Cancel
                                                </button>
                                            </span>
                                        ) : (
                                            <button
                                                type="button"
                                                onClick={() => provider.id && setConfirmDeleteId(provider.id)}
                                                className="text-gray-500 hover:text-red-600"
                                                aria-label="Delete provider"
                                            >
                                                <Trash2 size={14} />
                                            </button>
                                        )}
                                    </div>
                                    {t?.ok === false && t.error && (
                                        <div className="col-span-12 -mt-2 flex items-start gap-2 rounded border border-red-100 bg-red-50 px-3 py-2 text-xs text-red-700">
                                            <ShieldAlert size={14} className="mt-0.5 shrink-0" />
                                            <div>
                                                <div className="font-medium">Discovery failed</div>
                                                <div className="font-mono text-[11px]">{t.error}</div>
                                            </div>
                                        </div>
                                    )}
                                </div>
                            );
                        })
                    )}
                </div>
            </div>

            <AuthProviderDialog
                isOpen={dialogOpen}
                initial={editing}
                defaultRedirectUri={redirectUri}
                onClose={() => { setDialogOpen(false); setEditing(null); }}
                onSubmit={handleSubmit}
            />
        </div>
    );
}
