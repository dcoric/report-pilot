import { useEffect, useMemo, useState } from 'react';
import { History, Loader2, RotateCcw, X } from 'lucide-react';
import { toast } from 'sonner';
import { client } from '../../lib/api/client';
import type { components } from '../../lib/api/types';
import type { SavedQuery } from './types';

type SavedQueryVersion = components['schemas']['SavedQueryVersion'];

interface VersionHistoryDialogProps {
    savedQuery: SavedQuery;
    canRestore: boolean;
    isOpen: boolean;
    onClose: () => void;
    onRestored: () => void;
}

function formatTimestamp(value: string) {
    try {
        return new Date(value).toLocaleString();
    } catch {
        return value;
    }
}

export function VersionHistoryDialog({
    savedQuery,
    canRestore,
    isOpen,
    onClose,
    onRestored,
}: VersionHistoryDialogProps) {
    const [versions, setVersions] = useState<SavedQueryVersion[]>([]);
    const [selectedId, setSelectedId] = useState<string | null>(null);
    const [isLoading, setIsLoading] = useState(false);
    const [errorMessage, setErrorMessage] = useState<string | null>(null);
    const [pendingRestoreId, setPendingRestoreId] = useState<string | null>(null);

    const refresh = async () => {
        setIsLoading(true);
        setErrorMessage(null);
        const { data, error } = await client.GET('/v1/saved-queries/{savedQueryId}/versions', {
            params: { path: { savedQueryId: savedQuery.id } },
        });
        if (error || !data) {
            setErrorMessage('Failed to load version history.');
            setIsLoading(false);
            return;
        }
        const items = data.items as SavedQueryVersion[];
        setVersions(items);
        setSelectedId((current) => {
            if (current && items.some((row) => row.id === current)) return current;
            return items[0]?.id ?? null;
        });
        setIsLoading(false);
    };

    useEffect(() => {
        if (!isOpen) return;
        void refresh();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [isOpen, savedQuery.id]);

    const selectedVersion = useMemo(
        () => versions.find((row) => row.id === selectedId) ?? null,
        [versions, selectedId],
    );

    if (!isOpen) return null;

    const handleRestore = async (versionId: string) => {
        if (!canRestore) return;
        setPendingRestoreId(versionId);
        try {
            const { data, error } = await client.POST(
                '/v1/saved-queries/{savedQueryId}/versions/{versionId}/restore',
                { params: { path: { savedQueryId: savedQuery.id, versionId } } },
            );
            if (error || !data) {
                toast.error('Restore failed.');
                return;
            }
            toast.success(`Restored from version ${data.restored_from_version_number}.`);
            onRestored();
            await refresh();
        } finally {
            setPendingRestoreId(null);
        }
    };

    return (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
            <div className="flex h-[80vh] w-full max-w-4xl flex-col overflow-hidden rounded-lg bg-white shadow-xl">
                <div className="flex items-center justify-between border-b border-outline-variant px-4 py-3">
                    <div className="flex items-center gap-2">
                        <History size={16} className="text-oxblood" />
                        <div>
                            <h2 className="text-base font-semibold text-on-surface">Version History</h2>
                            <p className="text-xs text-slate-500">{savedQuery.name}</p>
                        </div>
                    </div>
                    <button
                        type="button"
                        onClick={onClose}
                        className="text-slate-500 hover:text-slate-800"
                        aria-label="Close version history"
                    >
                        <X size={18} />
                    </button>
                </div>

                <div className="flex flex-1 overflow-hidden">
                    <aside className="flex w-72 shrink-0 flex-col border-r border-outline-variant">
                        <div className="flex-1 overflow-y-auto">
                            {isLoading ? (
                                <div className="flex h-32 items-center justify-center text-sm text-slate-500">
                                    <Loader2 size={16} className="mr-2 animate-spin" />
                                    Loading…
                                </div>
                            ) : errorMessage ? (
                                <div className="m-4 rounded border border-red-200 bg-red-50 p-3 text-xs text-red-700">{errorMessage}</div>
                            ) : versions.length === 0 ? (
                                <div className="p-4 text-xs text-slate-500">No versions recorded yet.</div>
                            ) : (
                                <ul className="divide-y divide-outline-variant">
                                    {versions.map((row) => {
                                        const isSelected = row.id === selectedId;
                                        return (
                                            <li key={row.id}>
                                                <button
                                                    type="button"
                                                    onClick={() => setSelectedId(row.id)}
                                                    className={[
                                                        'flex w-full flex-col gap-0.5 px-3 py-2 text-left text-xs transition-colors',
                                                        isSelected ? 'bg-oxblood/5' : 'hover:bg-surface-container-low',
                                                    ].join(' ')}
                                                >
                                                    <div className="flex items-center justify-between gap-2">
                                                        <span className="font-mono text-[11px] font-semibold text-on-surface">
                                                            v{row.version_number}
                                                        </span>
                                                        <span className="text-[10px] text-slate-500">{formatTimestamp(row.created_at)}</span>
                                                    </div>
                                                    {row.change_summary && (
                                                        <span className="text-[11px] text-slate-600">{row.change_summary}</span>
                                                    )}
                                                    {row.created_by_user_id && (
                                                        <span className="font-mono text-[10px] text-slate-400">
                                                            {row.created_by_user_id.slice(0, 8)}…
                                                        </span>
                                                    )}
                                                </button>
                                            </li>
                                        );
                                    })}
                                </ul>
                            )}
                        </div>
                    </aside>

                    <section className="flex flex-1 flex-col overflow-hidden">
                        {selectedVersion ? (
                            <>
                                <div className="flex items-center justify-between border-b border-outline-variant px-4 py-2">
                                    <div className="text-xs text-slate-600">
                                        <span className="font-mono text-[11px] font-semibold text-on-surface">
                                            v{selectedVersion.version_number}
                                        </span>
                                        <span className="ml-2 text-slate-500">{formatTimestamp(selectedVersion.created_at)}</span>
                                    </div>
                                    {canRestore && (
                                        <button
                                            type="button"
                                            onClick={() => void handleRestore(selectedVersion.id)}
                                            disabled={pendingRestoreId === selectedVersion.id}
                                            className="flex items-center gap-1 rounded bg-oxblood px-3 py-1 text-xs font-medium text-white hover:bg-oxblood-soft disabled:cursor-not-allowed disabled:opacity-50"
                                        >
                                            {pendingRestoreId === selectedVersion.id ? (
                                                <Loader2 size={12} className="animate-spin" />
                                            ) : (
                                                <RotateCcw size={12} />
                                            )}
                                            Restore this version
                                        </button>
                                    )}
                                </div>
                                <div className="grid flex-1 grid-cols-2 overflow-hidden">
                                    <div className="flex flex-col overflow-hidden border-r border-outline-variant">
                                        <div className="border-b border-outline-variant bg-surface-container-low px-3 py-1 text-[10px] font-semibold uppercase tracking-wider text-slate-500">
                                            Current
                                        </div>
                                        <pre className="flex-1 overflow-auto whitespace-pre-wrap break-words bg-white p-3 font-mono text-[11px] leading-relaxed text-slate-800">
                                            {savedQuery.sql}
                                        </pre>
                                    </div>
                                    <div className="flex flex-col overflow-hidden">
                                        <div className="border-b border-outline-variant bg-surface-container-low px-3 py-1 text-[10px] font-semibold uppercase tracking-wider text-slate-500">
                                            v{selectedVersion.version_number}
                                            {savedQuery.sql === selectedVersion.sql && (
                                                <span className="ml-2 font-normal normal-case tracking-normal text-emerald-600">matches current</span>
                                            )}
                                        </div>
                                        <pre className="flex-1 overflow-auto whitespace-pre-wrap break-words bg-white p-3 font-mono text-[11px] leading-relaxed text-slate-800">
                                            {selectedVersion.sql}
                                        </pre>
                                    </div>
                                </div>
                            </>
                        ) : (
                            <div className="flex flex-1 items-center justify-center text-sm text-slate-500">
                                Select a version on the left to compare.
                            </div>
                        )}
                    </section>
                </div>
            </div>
        </div>
    );
}
