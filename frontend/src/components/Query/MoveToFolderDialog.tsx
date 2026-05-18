import { useMemo, useState } from 'react';
import { FolderClosed, Inbox, Loader2 } from 'lucide-react';
import type { SavedQuery } from './types';
import type { SavedQueryFolderTreeNode } from '../../hooks/useSavedQueryFolders';

interface MoveToFolderDialogProps {
    savedQuery: SavedQuery;
    tree: SavedQueryFolderTreeNode[];
    isSubmitting: boolean;
    onSubmit: (folderId: string | null) => Promise<void> | void;
    onCancel: () => void;
}

type FlatOption = { id: string | null; label: string; depth: number };

function flattenTree(nodes: SavedQueryFolderTreeNode[], depth = 0): FlatOption[] {
    const out: FlatOption[] = [];
    for (const node of nodes) {
        out.push({ id: node.id, label: node.name, depth });
        out.push(...flattenTree(node.children, depth + 1));
    }
    return out;
}

export function MoveToFolderDialog({
    savedQuery,
    tree,
    isSubmitting,
    onSubmit,
    onCancel,
}: MoveToFolderDialogProps) {
    const flat = useMemo(() => flattenTree(tree), [tree]);
    const initial = savedQuery.folder_id ?? null;
    const [selectedId, setSelectedId] = useState<string | null>(initial);

    const handleSubmit = async (event: React.FormEvent) => {
        event.preventDefault();
        await onSubmit(selectedId);
    };

    const unchanged = selectedId === initial;

    return (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 px-4">
            <form
                onSubmit={handleSubmit}
                className="flex max-h-[80vh] w-full max-w-sm flex-col rounded-md border border-outline-variant bg-white p-5 shadow-xl"
            >
                <h2 className="text-base font-semibold text-on-surface">Move to folder</h2>
                <p className="mt-1 truncate text-xs text-slate-500" title={savedQuery.name}>{savedQuery.name}</p>
                <div className="mt-4 flex-1 overflow-y-auto rounded border border-outline-variant bg-surface-container-low p-1 text-xs">
                    <button
                        type="button"
                        onClick={() => setSelectedId(null)}
                        className={[
                            'flex w-full items-center gap-2 rounded px-2 py-1 text-left',
                            selectedId === null
                                ? 'bg-oxblood/10 text-oxblood'
                                : 'text-on-surface hover:bg-white',
                        ].join(' ')}
                    >
                        <Inbox size={12} />
                        <span className="truncate">Unfiled (root)</span>
                    </button>
                    {flat.length === 0 ? (
                        <p className="px-2 py-4 text-center text-[11px] text-slate-400">No folders yet — create one from the library tree first.</p>
                    ) : (
                        flat.map((option) => (
                            <button
                                key={option.id}
                                type="button"
                                onClick={() => setSelectedId(option.id)}
                                className={[
                                    'flex w-full items-center gap-2 rounded px-2 py-1 text-left',
                                    selectedId === option.id
                                        ? 'bg-oxblood/10 text-oxblood'
                                        : 'text-on-surface hover:bg-white',
                                ].join(' ')}
                                style={{ paddingLeft: `${option.depth * 12 + 8}px` }}
                            >
                                <FolderClosed size={12} className="text-amber-accent" />
                                <span className="truncate">{option.label}</span>
                            </button>
                        ))
                    )}
                </div>
                <div className="mt-5 flex justify-end gap-2">
                    <button
                        type="button"
                        onClick={onCancel}
                        disabled={isSubmitting}
                        className="rounded border border-outline-variant bg-white px-3 py-1.5 text-xs font-medium text-on-surface hover:bg-surface-container-low disabled:cursor-not-allowed disabled:opacity-50"
                    >
                        Cancel
                    </button>
                    <button
                        type="submit"
                        disabled={isSubmitting || unchanged}
                        className="inline-flex items-center gap-1.5 rounded bg-oxblood px-3 py-1.5 text-xs font-medium text-white hover:bg-oxblood-soft disabled:cursor-not-allowed disabled:opacity-50"
                    >
                        {isSubmitting && <Loader2 size={12} className="animate-spin" />}
                        Move
                    </button>
                </div>
            </form>
        </div>
    );
}
