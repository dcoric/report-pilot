import { useEffect, useState, type FormEvent } from 'react';
import { Loader2, Plus, Share2, Trash2, X } from 'lucide-react';
import { toast } from 'sonner';
import { client } from '../../lib/api/client';
import type { components } from '../../lib/api/types';
import type { SavedQuery } from './types';

type AccessResponse = components['schemas']['SavedQueryAccessResponse'];
type ShareRecord = components['schemas']['SavedQueryShareRecord'];
type Visibility = NonNullable<components['schemas']['SavedQuery']['visibility']>;
type Permission = 'view' | 'run';

interface ShareSavedQueryDialogProps {
    savedQuery: SavedQuery;
    isOpen: boolean;
    onClose: () => void;
    onUpdated: (visibility: Visibility) => void;
}

interface DraftGrant {
    user_id: string;
    permission: Permission;
}

export function ShareSavedQueryDialog({
    savedQuery,
    isOpen,
    onClose,
    onUpdated,
}: ShareSavedQueryDialogProps) {
    const [visibility, setVisibility] = useState<Visibility>(savedQuery.visibility);
    const [grants, setGrants] = useState<DraftGrant[]>([]);
    const [newUserId, setNewUserId] = useState('');
    const [newPermission, setNewPermission] = useState<Permission>('view');
    const [isLoading, setIsLoading] = useState(false);
    const [isSubmitting, setIsSubmitting] = useState(false);
    const [error, setError] = useState<string | null>(null);

    useEffect(() => {
        if (!isOpen) return;
        let cancelled = false;
        const load = async () => {
            setIsLoading(true);
            setError(null);
            const { data, error: fetchError } = await client.GET('/v1/saved-queries/{savedQueryId}/access', {
                params: { path: { savedQueryId: savedQuery.id } },
            });
            if (cancelled) return;
            if (fetchError || !data) {
                setError('Failed to load access information.');
                setIsLoading(false);
                return;
            }
            const access = data as AccessResponse;
            setVisibility(access.visibility);
            setGrants(access.shares.map((row: ShareRecord) => ({
                user_id: row.user_id,
                permission: row.permission as Permission,
            })));
            setIsLoading(false);
        };
        void load();
        return () => { cancelled = true; };
    }, [isOpen, savedQuery.id]);

    if (!isOpen) return null;

    const addGrant = () => {
        const trimmed = newUserId.trim();
        if (!trimmed) return;
        if (grants.some((g) => g.user_id === trimmed)) {
            toast.error('That user is already on the list.');
            return;
        }
        setGrants((current) => [...current, { user_id: trimmed, permission: newPermission }]);
        setNewUserId('');
        setNewPermission('view');
    };

    const updateGrantPermission = (userId: string, permission: Permission) => {
        setGrants((current) => current.map((g) => (g.user_id === userId ? { ...g, permission } : g)));
    };

    const removeGrant = (userId: string) => {
        setGrants((current) => current.filter((g) => g.user_id !== userId));
    };

    const handleSubmit = async (event: FormEvent) => {
        event.preventDefault();
        setIsSubmitting(true);
        setError(null);
        try {
            const { data, error: shareError, response } = await client.POST('/v1/saved-queries/{savedQueryId}/share', {
                params: { path: { savedQueryId: savedQuery.id } },
                body: { visibility, shares: grants },
            });
            if (shareError || !data) {
                const payload = shareError as { message?: string } | undefined;
                setError(payload?.message || `Share update failed (HTTP ${response.status}).`);
                return;
            }
            toast.success('Sharing updated.');
            onUpdated(data.visibility);
            onClose();
        } finally {
            setIsSubmitting(false);
        }
    };

    return (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
            <div className="w-full max-w-lg overflow-hidden rounded-lg bg-white shadow-xl">
                <div className="flex items-center justify-between border-b border-outline-variant px-4 py-3">
                    <div className="flex items-center gap-2">
                        <Share2 size={16} className="text-oxblood" />
                        <div>
                            <h2 className="text-base font-semibold text-on-surface">Share Saved Query</h2>
                            <p className="text-xs text-slate-500">{savedQuery.name}</p>
                        </div>
                    </div>
                    <button
                        type="button"
                        onClick={onClose}
                        className="text-slate-500 hover:text-slate-800"
                        aria-label="Close share dialog"
                    >
                        <X size={18} />
                    </button>
                </div>

                {isLoading ? (
                    <div className="flex h-40 items-center justify-center text-sm text-slate-500">
                        <Loader2 className="mr-2 animate-spin" size={16} />
                        Loading…
                    </div>
                ) : (
                    <form onSubmit={handleSubmit} className="space-y-5 p-4">
                        <div>
                            <label className="mb-1 block text-sm font-medium text-slate-700">Visibility</label>
                            <div className="flex gap-3 text-sm">
                                <label className="inline-flex items-center gap-1.5">
                                    <input
                                        type="radio"
                                        name="visibility"
                                        value="private"
                                        checked={visibility === 'private'}
                                        onChange={() => setVisibility('private')}
                                    />
                                    <span>Private</span>
                                </label>
                                <label className="inline-flex items-center gap-1.5">
                                    <input
                                        type="radio"
                                        name="visibility"
                                        value="shared"
                                        checked={visibility === 'shared'}
                                        onChange={() => setVisibility('shared')}
                                    />
                                    <span>Shared (read-only to everyone)</span>
                                </label>
                            </div>
                            <p className="mt-1 text-[11px] text-slate-500">
                                Private queries are visible only to you and the users granted access below. Shared queries
                                are read-only to every authenticated user.
                            </p>
                        </div>

                        <div>
                            <label className="mb-1 block text-sm font-medium text-slate-700">
                                Per-user grants
                                <span className="ml-2 text-xs font-normal text-slate-400">{grants.length}</span>
                            </label>
                            <div className="space-y-2">
                                {grants.length === 0 ? (
                                    <p className="rounded border border-dashed border-outline-variant px-3 py-3 text-xs text-slate-500">
                                        No per-user grants. Add one below to share with a specific user.
                                    </p>
                                ) : (
                                    grants.map((grant) => (
                                        <div
                                            key={grant.user_id}
                                            className="flex items-center gap-2 rounded border border-outline-variant px-2 py-1.5"
                                        >
                                            <span className="flex-1 truncate font-mono text-[11px] text-slate-700">
                                                {grant.user_id}
                                            </span>
                                            <select
                                                value={grant.permission}
                                                onChange={(event) => updateGrantPermission(grant.user_id, event.target.value as Permission)}
                                                className="rounded border border-outline-variant bg-white px-1.5 py-1 text-xs"
                                            >
                                                <option value="view">view</option>
                                                <option value="run">run</option>
                                            </select>
                                            <button
                                                type="button"
                                                onClick={() => removeGrant(grant.user_id)}
                                                className="rounded p-1 text-slate-500 hover:bg-red-50 hover:text-red-600"
                                                aria-label="Remove grant"
                                            >
                                                <Trash2 size={12} />
                                            </button>
                                        </div>
                                    ))
                                )}
                            </div>

                            <div className="mt-3 flex items-center gap-2">
                                <input
                                    type="text"
                                    value={newUserId}
                                    onChange={(event) => setNewUserId(event.target.value)}
                                    placeholder="user UUID"
                                    className="flex-1 rounded border border-outline-variant px-2 py-1.5 font-mono text-[11px] focus:border-oxblood focus:outline-none focus:ring-1 focus:ring-oxblood"
                                />
                                <select
                                    value={newPermission}
                                    onChange={(event) => setNewPermission(event.target.value as Permission)}
                                    className="rounded border border-outline-variant bg-white px-2 py-1.5 text-xs"
                                >
                                    <option value="view">view</option>
                                    <option value="run">run</option>
                                </select>
                                <button
                                    type="button"
                                    onClick={addGrant}
                                    disabled={!newUserId.trim()}
                                    className="flex items-center gap-1 rounded bg-oxblood px-2.5 py-1.5 text-xs font-medium text-white hover:bg-oxblood-soft disabled:cursor-not-allowed disabled:opacity-50"
                                >
                                    <Plus size={12} />
                                    Add
                                </button>
                            </div>
                            <p className="mt-1 text-[11px] text-slate-500">
                                Provide the user's UUID. `view` lets them see the query in their library; `run` also lets them execute it.
                            </p>
                        </div>

                        {error && (
                            <div className="rounded border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">{error}</div>
                        )}

                        <div className="flex justify-end gap-2 border-t border-outline-variant pt-4">
                            <button
                                type="button"
                                onClick={onClose}
                                disabled={isSubmitting}
                                className="rounded-md border border-outline-variant bg-white px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50"
                            >
                                Cancel
                            </button>
                            <button
                                type="submit"
                                disabled={isSubmitting}
                                className="rounded-md bg-oxblood px-4 py-2 text-sm font-medium text-white hover:bg-oxblood-soft disabled:cursor-not-allowed disabled:opacity-50"
                            >
                                {isSubmitting ? 'Saving…' : 'Save Sharing'}
                            </button>
                        </div>
                    </form>
                )}
            </div>
        </div>
    );
}
