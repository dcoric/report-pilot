import { useCallback, useEffect, useState } from 'react';
import { Copy, Plus, RefreshCw, Trash2, X } from 'lucide-react';
import { format } from 'date-fns';
import { toast } from 'sonner';
import { client } from '../../lib/api/client';
import type { components } from '../../lib/api/types';

type TokenRecord = components['schemas']['ScimTokenRecord'];

interface Props {
    isOpen: boolean;
    providerId: string;
    providerName: string;
    initialGroupMappings: Record<string, string>;
    onClose: () => void;
}

type MappingRow = { groupName: string; roleName: string };

function mappingsToRows(mapping: Record<string, string>): MappingRow[] {
    return Object.entries(mapping).map(([groupName, roleName]) => ({ groupName, roleName }));
}

function rowsToMapping(rows: MappingRow[]): Record<string, string> {
    const out: Record<string, string> = {};
    for (const { groupName, roleName } of rows) {
        const g = groupName.trim();
        const r = roleName.trim();
        if (g && r) out[g] = r;
    }
    return out;
}

export function ScimDialog({ isOpen, providerId, providerName, initialGroupMappings, onClose }: Props) {
    const [tokens, setTokens] = useState<TokenRecord[]>([]);
    const [tokenLabel, setTokenLabel] = useState('');
    const [issuing, setIssuing] = useState(false);
    const [revealedToken, setRevealedToken] = useState<{ id: string; token: string } | null>(null);
    const [rows, setRows] = useState<MappingRow[]>(mappingsToRows(initialGroupMappings));
    const [savingMappings, setSavingMappings] = useState(false);
    const [loadingTokens, setLoadingTokens] = useState(true);

    const reloadTokens = useCallback(async () => {
        setLoadingTokens(true);
        try {
            const { data } = await client.GET('/v1/admin/auth-providers/{providerId}/scim-tokens', {
                params: { path: { providerId } },
            });
            setTokens(data?.items ?? []);
        } finally {
            setLoadingTokens(false);
        }
    }, [providerId]);

    useEffect(() => {
        if (!isOpen) return;
        setRows(mappingsToRows(initialGroupMappings));
        setRevealedToken(null);
        setTokenLabel('');
        void reloadTokens();
    }, [isOpen, providerId, initialGroupMappings, reloadTokens]);

    async function handleIssueToken() {
        const label = tokenLabel.trim();
        if (!label) {
            toast.error('Token label is required.');
            return;
        }
        setIssuing(true);
        const { data, response, error } = await client.POST('/v1/admin/auth-providers/{providerId}/scim-tokens', {
            params: { path: { providerId } },
            body: { label },
        });
        setIssuing(false);
        if (!response.ok || !data) {
            const msg = (error && typeof error === 'object' && 'message' in error && typeof (error as { message?: string }).message === 'string')
                ? (error as { message: string }).message
                : `Failed (${response.status}).`;
            toast.error(msg);
            return;
        }
        setRevealedToken({ id: data.record.id, token: data.token });
        setTokenLabel('');
        toast.success('Token issued. Copy it now — it will not be shown again.');
        await reloadTokens();
    }

    async function handleRevoke(tokenId: string) {
        const { response } = await client.DELETE('/v1/admin/auth-providers/{providerId}/scim-tokens/{tokenId}', {
            params: { path: { providerId, tokenId } },
        });
        if (response.ok) {
            toast.success('Token revoked.');
            await reloadTokens();
        } else {
            toast.error('Failed to revoke token.');
        }
    }

    async function handleSaveMappings() {
        setSavingMappings(true);
        const body = rowsToMapping(rows);
        const { response, error } = await client.POST(
            '/v1/admin/auth-providers/{providerId}/scim-group-mappings',
            { params: { path: { providerId } }, body },
        );
        setSavingMappings(false);
        if (!response.ok) {
            const msg = (error && typeof error === 'object' && 'message' in error && typeof (error as { message?: string }).message === 'string')
                ? (error as { message: string }).message
                : `Failed (${response.status}).`;
            toast.error(msg);
            return;
        }
        toast.success('SCIM group mapping saved.');
    }

    function setRow(idx: number, patch: Partial<MappingRow>) {
        setRows((prev) => prev.map((row, i) => (i === idx ? { ...row, ...patch } : row)));
    }
    function addRow() { setRows((prev) => [...prev, { groupName: '', roleName: '' }]); }
    function removeRow(idx: number) { setRows((prev) => prev.filter((_, i) => i !== idx)); }

    if (!isOpen) return null;

    return (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black bg-opacity-50 p-4">
            <div className="w-full max-w-3xl rounded-lg bg-white shadow-xl">
                <div className="flex items-center justify-between border-b p-4">
                    <h2 className="text-lg font-semibold">SCIM provisioning · {providerName}</h2>
                    <button onClick={onClose} className="text-gray-500 hover:text-gray-700" aria-label="Close" type="button">
                        <X size={20} />
                    </button>
                </div>

                <div className="space-y-6 p-4">
                    <section>
                        <h3 className="mb-1 text-sm font-semibold text-gray-800">Bearer tokens</h3>
                        <p className="mb-3 text-xs text-gray-500">
                            Issue a token to paste into your IdP&apos;s SCIM configuration. The plaintext is shown <strong>once</strong>.
                            Endpoint: <code className="rounded bg-gray-100 px-1 py-0.5">{`${typeof window === 'undefined' ? '' : window.location.origin}/scim/v2`}</code>
                        </p>

                        <div className="mb-3 flex gap-2">
                            <input
                                type="text"
                                value={tokenLabel}
                                onChange={(e) => setTokenLabel(e.target.value)}
                                placeholder="Label (e.g. 'okta-prod')"
                                className="flex-1 rounded-md border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-oxblood"
                            />
                            <button
                                type="button"
                                onClick={() => void handleIssueToken()}
                                disabled={issuing}
                                className="flex items-center gap-1 rounded-md bg-oxblood px-3 py-2 text-sm font-medium text-white hover:bg-oxblood-deep disabled:opacity-60"
                            >
                                <Plus size={14} /> Issue token
                            </button>
                        </div>

                        {revealedToken && (
                            <div className="mb-3 rounded-md border border-amber-300 bg-amber-50 p-3 text-xs">
                                <div className="mb-1 font-semibold text-amber-900">Save this token now — it will never be shown again.</div>
                                <div className="flex items-center gap-2">
                                    <code className="flex-1 break-all rounded bg-white px-2 py-1 font-mono text-[11px] text-gray-800">{revealedToken.token}</code>
                                    <button
                                        type="button"
                                        onClick={() => {
                                            if (navigator.clipboard) {
                                                void navigator.clipboard.writeText(revealedToken.token).then(() => toast.success('Copied.'));
                                            }
                                        }}
                                        className="rounded px-2 py-1 text-xs text-gray-700 hover:bg-gray-100"
                                        aria-label="Copy token"
                                    >
                                        <Copy size={14} />
                                    </button>
                                </div>
                            </div>
                        )}

                        <div className="overflow-hidden rounded-md border border-gray-200">
                            <div className="grid grid-cols-12 gap-2 border-b border-gray-200 bg-gray-50 px-3 py-2 text-[11px] font-medium uppercase tracking-wider text-gray-500">
                                <div className="col-span-4">Label</div>
                                <div className="col-span-3">Created</div>
                                <div className="col-span-3">Last used</div>
                                <div className="col-span-2 text-right">Actions</div>
                            </div>
                            {loadingTokens ? (
                                <div className="flex items-center justify-center py-6 text-xs text-gray-500">
                                    <RefreshCw size={14} className="mr-2 animate-spin" /> Loading…
                                </div>
                            ) : tokens.length === 0 ? (
                                <div className="px-3 py-4 text-xs text-gray-500">No SCIM tokens issued yet.</div>
                            ) : (
                                tokens.map((token) => (
                                    <div key={token.id} className="grid grid-cols-12 items-center gap-2 border-b border-gray-100 px-3 py-2 text-xs last:border-b-0">
                                        <div className="col-span-4 font-medium text-gray-800">{token.label}</div>
                                        <div className="col-span-3 text-gray-500">{format(new Date(token.created_at), 'yyyy-MM-dd HH:mm')}</div>
                                        <div className="col-span-3 text-gray-500">
                                            {token.last_used_at ? format(new Date(token.last_used_at), 'yyyy-MM-dd HH:mm') : '—'}
                                            {token.revoked_at && <span className="ml-2 rounded bg-red-100 px-1.5 py-0.5 text-[10px] text-red-700">revoked</span>}
                                        </div>
                                        <div className="col-span-2 text-right">
                                            {!token.revoked_at && (
                                                <button
                                                    type="button"
                                                    onClick={() => void handleRevoke(token.id)}
                                                    className="text-gray-500 hover:text-red-600"
                                                    aria-label="Revoke token"
                                                >
                                                    <Trash2 size={14} />
                                                </button>
                                            )}
                                        </div>
                                    </div>
                                ))
                            )}
                        </div>
                    </section>

                    <section>
                        <h3 className="mb-1 text-sm font-semibold text-gray-800">Group → role mapping</h3>
                        <p className="mb-3 text-xs text-gray-500">
                            SCIM Group <code>displayName</code> on the left, local role on the right. Saving replaces the entire map.
                            Lookup is case-insensitive.
                        </p>

                        <div className="space-y-2">
                            {rows.map((row, idx) => (
                                <div key={idx} className="flex items-center gap-2">
                                    <input
                                        type="text"
                                        value={row.groupName}
                                        onChange={(e) => setRow(idx, { groupName: e.target.value })}
                                        placeholder="Analysts"
                                        className="flex-1 rounded-md border border-gray-300 px-3 py-1.5 font-mono text-sm focus:outline-none focus:ring-2 focus:ring-oxblood"
                                    />
                                    <span className="text-gray-400">→</span>
                                    <input
                                        type="text"
                                        value={row.roleName}
                                        onChange={(e) => setRow(idx, { roleName: e.target.value })}
                                        placeholder="analyst"
                                        className="flex-1 rounded-md border border-gray-300 px-3 py-1.5 font-mono text-sm focus:outline-none focus:ring-2 focus:ring-oxblood"
                                    />
                                    <button
                                        type="button"
                                        onClick={() => removeRow(idx)}
                                        className="text-gray-500 hover:text-red-600"
                                        aria-label="Remove mapping"
                                    >
                                        <Trash2 size={14} />
                                    </button>
                                </div>
                            ))}
                        </div>
                        <button
                            type="button"
                            onClick={addRow}
                            className="mt-3 inline-flex items-center gap-1 rounded-md border border-dashed border-gray-300 px-3 py-1 text-xs text-gray-600 hover:border-gray-400"
                        >
                            <Plus size={12} /> Add mapping
                        </button>

                        <div className="mt-3 flex justify-end">
                            <button
                                type="button"
                                onClick={() => void handleSaveMappings()}
                                disabled={savingMappings}
                                className="rounded-md bg-oxblood px-3 py-2 text-sm font-medium text-white hover:bg-oxblood-deep disabled:opacity-60"
                            >
                                {savingMappings ? 'Saving…' : 'Save mappings'}
                            </button>
                        </div>
                    </section>
                </div>

                <div className="flex items-center justify-end border-t bg-gray-50 px-4 py-3">
                    <button
                        type="button"
                        onClick={onClose}
                        className="rounded-md border border-gray-300 bg-white px-3 py-2 text-sm text-gray-700 hover:bg-gray-100"
                    >
                        Close
                    </button>
                </div>
            </div>
        </div>
    );
}
