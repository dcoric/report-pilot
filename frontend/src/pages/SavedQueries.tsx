import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { format } from 'date-fns';
import Editor from '@monaco-editor/react';
import {
    Copy,
    Database,
    FileText,
    Filter,
    Loader2,
    MoreVertical,
    Pencil,
    Plus,
    RefreshCw,
    Search,
    Trash2,
} from 'lucide-react';
import { toast } from 'sonner';
import { useDataSource } from '../hooks/useDataSource';
import { useSavedQueries } from '../hooks/useSavedQueries';
import { SaveQueryDialog, type SaveQueryDialogValues } from '../components/Query/SaveQueryDialog';
import type { SavedQuery } from '../components/Query/types';

type FilterMode = 'current' | 'all';

function formatDate(value: string) {
    try {
        return format(new Date(value), 'MMM d, yyyy');
    } catch {
        return '—';
    }
}

export const SavedQueries = () => {
    const navigate = useNavigate();
    const { dataSources, selectedDataSourceId } = useDataSource();
    const {
        savedQueries,
        isLoading,
        errorMessage,
        refresh,
        updateSavedQuery,
        duplicateSavedQuery,
        deleteSavedQuery,
    } = useSavedQueries();

    const [searchText, setSearchText] = useState('');
    const [filterMode, setFilterMode] = useState<FilterMode>('all');
    const [activeTagFilter, setActiveTagFilter] = useState<string | null>(null);
    const [selectedId, setSelectedId] = useState<string | null>(null);
    const [editing, setEditing] = useState<SavedQuery | null>(null);
    const [isSubmittingEdit, setIsSubmittingEdit] = useState(false);
    const [pendingId, setPendingId] = useState<string | null>(null);
    const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);

    const dataSourceNameById = useMemo(
        () => Object.fromEntries(dataSources.map((ds) => [ds.id, ds.name])),
        [dataSources],
    );

    const dataSourceTypeById = useMemo(
        () => Object.fromEntries(dataSources.map((ds) => [ds.id, ds.db_type])),
        [dataSources],
    );

    const filtered = useMemo(() => {
        const search = searchText.trim().toLowerCase();
        return savedQueries.filter((entry) => {
            if (filterMode === 'current' && selectedDataSourceId && entry.data_source_id !== selectedDataSourceId) {
                return false;
            }
            if (activeTagFilter && !(entry.tags || []).includes(activeTagFilter)) {
                return false;
            }
            if (!search) {
                return true;
            }
            const haystack = [
                entry.name,
                entry.description ?? '',
                ...(entry.tags ?? []),
            ].join(' ').toLowerCase();
            return haystack.includes(search);
        });
    }, [savedQueries, searchText, filterMode, selectedDataSourceId, activeTagFilter]);

    useEffect(() => {
        if (selectedId && !filtered.some((entry) => entry.id === selectedId)) {
            setSelectedId(filtered[0]?.id ?? null);
            return;
        }
        if (!selectedId && filtered.length > 0) {
            setSelectedId(filtered[0].id);
        }
    }, [filtered, selectedId]);

    const selectedQuery = filtered.find((entry) => entry.id === selectedId) || null;

    const monacoLanguage = selectedQuery
        ? dataSourceTypeById[selectedQuery.data_source_id] === 'mssql'
            ? 'sql'
            : 'sql'
        : 'sql';

    const openInWorkspace = (id: string) => {
        navigate(`/query?savedQueryId=${id}`);
    };

    const handleSaveEdit = async (values: SaveQueryDialogValues) => {
        if (!editing) return;
        setIsSubmittingEdit(true);
        try {
            const result = await updateSavedQuery(editing.id, {
                name: values.name,
                description: values.description,
                dataSourceId: editing.data_source_id,
                sql: editing.sql,
                defaultRunParams: editing.default_run_params,
                parameterSchema: editing.parameter_schema,
                tags: values.tags,
            });
            if (result) {
                toast.success('Saved query updated.');
                setEditing(null);
            }
        } finally {
            setIsSubmittingEdit(false);
        }
    };

    const handleDuplicate = async (savedQuery: SavedQuery) => {
        if (pendingId) return;
        setPendingId(savedQuery.id);
        try {
            await duplicateSavedQuery(savedQuery);
        } finally {
            setPendingId(null);
        }
    };

    const handleDelete = async (id: string) => {
        if (pendingId) return;
        setPendingId(id);
        try {
            const ok = await deleteSavedQuery(id);
            if (ok) {
                if (selectedId === id) {
                    setSelectedId(null);
                }
                setConfirmDeleteId(null);
                toast.success('Saved query deleted.');
            }
        } finally {
            setPendingId(null);
        }
    };

    return (
        <main className="flex h-full overflow-hidden">
            <div className="flex flex-1 flex-col overflow-hidden border-r border-outline-variant bg-white">
                <div className="shrink-0 border-b border-outline-variant bg-white px-6 pb-4 pt-6">
                    <div className="mb-6 flex items-end justify-between">
                        <div>
                            <h1 className="text-2xl font-semibold tracking-tight text-on-surface">Saved Queries</h1>
                            <p className="mt-1 text-xs text-slate-500">Manage and execute your analytical library.</p>
                        </div>
                        <div className="flex gap-2">
                            <button
                                type="button"
                                onClick={() => setFilterMode((mode) => (mode === 'all' ? 'current' : 'all'))}
                                className="flex items-center gap-2 rounded border border-outline-variant bg-white px-3 py-1.5 text-xs font-medium text-on-surface hover:bg-surface-container-low"
                                title={filterMode === 'all' ? 'Showing all data sources' : 'Showing current data source only'}
                            >
                                <Filter size={14} />
                                {filterMode === 'all' ? 'All Data Sources' : 'Current Only'}
                            </button>
                            <button
                                type="button"
                                onClick={() => navigate('/query')}
                                className="flex items-center gap-2 rounded bg-oxblood px-3 py-1.5 text-xs font-medium text-white shadow-sm hover:bg-oxblood-soft"
                            >
                                <Plus size={14} />
                                New Query
                            </button>
                            <button
                                type="button"
                                onClick={() => void refresh()}
                                className="rounded border border-outline-variant bg-white p-1.5 text-slate-600 hover:bg-surface-container-low"
                                title="Refresh saved queries"
                                aria-label="Refresh saved queries"
                            >
                                <RefreshCw size={14} />
                            </button>
                        </div>
                    </div>

                    <div className="relative">
                        <Search size={16} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
                        <input
                            type="text"
                            value={searchText}
                            onChange={(event) => setSearchText(event.target.value)}
                            placeholder="Search queries by name, tag, or description…"
                            className="w-full rounded border border-outline-variant bg-surface-container-low py-2 pl-9 pr-4 text-sm text-on-surface placeholder-slate-400 focus:border-oxblood focus:outline-none focus:ring-1 focus:ring-oxblood"
                        />
                    </div>

                    {activeTagFilter && (
                        <div className="mt-3 flex items-center gap-2 text-xs text-slate-500">
                            <span>Filtering by tag:</span>
                            <span className="inline-flex items-center gap-1 rounded bg-amber-accent/20 px-2 py-0.5 font-medium text-on-secondary-container">
                                #{activeTagFilter}
                                <button
                                    type="button"
                                    onClick={() => setActiveTagFilter(null)}
                                    className="text-slate-500 hover:text-slate-800"
                                    aria-label="Clear tag filter"
                                >
                                    ×
                                </button>
                            </span>
                        </div>
                    )}
                </div>

                <div className="flex-1 overflow-y-auto">
                    {isLoading ? (
                        <div className="flex h-full flex-col items-center justify-center gap-2 text-sm text-slate-500">
                            <Loader2 size={20} className="animate-spin" />
                            <span>Loading saved queries…</span>
                        </div>
                    ) : errorMessage ? (
                        <div className="m-6 space-y-3 rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-700">
                            <p>{errorMessage}</p>
                            <button
                                type="button"
                                onClick={() => void refresh()}
                                className="inline-flex items-center gap-1 rounded-md border border-red-200 bg-white px-2 py-1 text-xs font-medium text-red-700 hover:bg-red-100"
                            >
                                <RefreshCw size={12} />
                                Retry
                            </button>
                        </div>
                    ) : savedQueries.length === 0 ? (
                        <div className="flex h-full flex-col items-center justify-center px-4 py-10 text-center text-sm text-slate-500">
                            <FileText size={32} className="mb-3 text-slate-300" />
                            <p className="font-medium text-slate-700">No saved queries yet</p>
                            <p className="mt-1 text-xs">Save a query from the workspace to start building your library.</p>
                        </div>
                    ) : filtered.length === 0 ? (
                        <div className="flex h-full flex-col items-center justify-center px-4 py-10 text-center text-sm text-slate-500">
                            <Search size={28} className="mb-3 text-slate-300" />
                            <p className="font-medium text-slate-700">No matches found</p>
                            <p className="mt-1 text-xs">Adjust the search text or switch the filter.</p>
                        </div>
                    ) : (
                        <table className="w-full border-collapse text-left">
                            <thead className="sticky top-0 z-10 border-b border-outline-variant bg-surface-container-low">
                                <tr className="text-[11px] uppercase tracking-wider text-slate-500">
                                    <th className="w-10 px-3 py-2 text-center">
                                        <input type="checkbox" className="h-3 w-3 rounded border-outline-variant" />
                                    </th>
                                    <th className="px-3 py-2 font-semibold">Name &amp; Path</th>
                                    <th className="px-3 py-2 font-semibold">Tags</th>
                                    <th className="px-3 py-2 font-semibold">Last Modified</th>
                                    <th className="w-16 px-3 py-2"></th>
                                </tr>
                            </thead>
                            <tbody className="text-xs">
                                {filtered.map((entry) => {
                                    const isSelected = entry.id === selectedId;
                                    return (
                                        <tr
                                            key={entry.id}
                                            onClick={() => setSelectedId(entry.id)}
                                            className={[
                                                'cursor-pointer border-b border-outline-variant transition-colors',
                                                isSelected ? 'bg-surface-container' : 'hover:bg-surface-container-low',
                                            ].join(' ')}
                                        >
                                            <td className={[
                                                'border-l-2 px-3 py-2 text-center',
                                                isSelected ? 'border-oxblood' : 'border-transparent',
                                            ].join(' ')}>
                                                <input
                                                    type="checkbox"
                                                    onClick={(event) => event.stopPropagation()}
                                                    className="h-3 w-3 rounded border-outline-variant"
                                                />
                                            </td>
                                            <td className="px-3 py-2">
                                                <div className="flex items-center gap-2">
                                                    <div className="flex h-6 w-6 shrink-0 items-center justify-center rounded border border-outline-variant bg-amber-accent/20">
                                                        <span className="font-mono text-[9px] font-bold text-on-primary-fixed">SQL</span>
                                                    </div>
                                                    <div className="min-w-0">
                                                        <button
                                                            type="button"
                                                            onClick={(event) => {
                                                                event.stopPropagation();
                                                                openInWorkspace(entry.id);
                                                            }}
                                                            className="truncate text-left text-[13px] font-semibold leading-tight text-on-surface hover:text-oxblood"
                                                        >
                                                            {entry.name}
                                                        </button>
                                                        <div className="mt-0.5 flex items-center gap-1 text-[11px] text-slate-500">
                                                            <Database size={10} />
                                                            <span className="truncate">
                                                                {dataSourceNameById[entry.data_source_id] || 'Unknown source'}
                                                            </span>
                                                        </div>
                                                    </div>
                                                </div>
                                            </td>
                                            <td className="px-3 py-2">
                                                <div className="flex flex-wrap gap-1">
                                                    {(entry.tags ?? []).map((tag) => (
                                                        <button
                                                            key={tag}
                                                            type="button"
                                                            onClick={(event) => {
                                                                event.stopPropagation();
                                                                setActiveTagFilter(tag);
                                                            }}
                                                            className="rounded-sm border border-outline-variant bg-amber-accent/20 px-1.5 py-0.5 text-[10px] font-medium text-on-secondary-container hover:bg-amber-accent/30"
                                                        >
                                                            #{tag}
                                                        </button>
                                                    ))}
                                                </div>
                                            </td>
                                            <td className="px-3 py-2 text-on-surface">
                                                <div>{formatDate(entry.updated_at)}</div>
                                                <div className="text-[11px] text-slate-500">by {entry.owner_id}</div>
                                            </td>
                                            <td className="px-3 py-2 text-right">
                                                <button
                                                    type="button"
                                                    onClick={(event) => event.stopPropagation()}
                                                    className="rounded p-1 text-slate-400 hover:bg-surface-container-high hover:text-slate-700"
                                                    title="Row actions"
                                                    aria-label="Row actions"
                                                >
                                                    <MoreVertical size={16} />
                                                </button>
                                            </td>
                                        </tr>
                                    );
                                })}
                            </tbody>
                        </table>
                    )}
                </div>
            </div>

            <aside className="flex w-[450px] flex-col overflow-hidden border-l border-outline-variant bg-white">
                {selectedQuery ? (
                    <>
                        <div className="shrink-0 border-b border-outline-variant p-6">
                            <div className="mb-4 flex items-start justify-between">
                                <div className="flex h-10 w-10 items-center justify-center rounded border border-outline-variant bg-amber-accent/20">
                                    <span className="font-mono text-sm font-bold text-on-primary-fixed">SQL</span>
                                </div>
                                <div className="flex gap-1">
                                    <button
                                        type="button"
                                        onClick={() => void handleDuplicate(selectedQuery)}
                                        disabled={pendingId === selectedQuery.id}
                                        className="rounded border border-transparent p-1.5 text-slate-500 hover:border-outline-variant hover:bg-surface-container-low hover:text-on-surface disabled:cursor-not-allowed disabled:opacity-50"
                                        title="Duplicate"
                                    >
                                        {pendingId === selectedQuery.id ? <Loader2 size={16} className="animate-spin" /> : <Copy size={16} />}
                                    </button>
                                    <button
                                        type="button"
                                        onClick={() => setEditing(selectedQuery)}
                                        className="rounded border border-transparent p-1.5 text-slate-500 hover:border-outline-variant hover:bg-surface-container-low hover:text-on-surface"
                                        title="Edit metadata"
                                    >
                                        <Pencil size={16} />
                                    </button>
                                    <button
                                        type="button"
                                        onClick={() => setConfirmDeleteId(selectedQuery.id)}
                                        className="rounded border border-transparent p-1.5 text-slate-500 hover:border-red-200 hover:bg-red-50 hover:text-red-600"
                                        title="Delete"
                                    >
                                        <Trash2 size={16} />
                                    </button>
                                </div>
                            </div>
                            <h2 className="mb-2 text-lg font-semibold leading-tight text-on-surface">{selectedQuery.name}</h2>
                            {selectedQuery.description && (
                                <p className="mb-4 line-clamp-2 text-xs text-slate-600">{selectedQuery.description}</p>
                            )}
                            <button
                                type="button"
                                onClick={() => openInWorkspace(selectedQuery.id)}
                                className="flex w-full items-center justify-center gap-2 rounded bg-oxblood px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-oxblood-soft"
                            >
                                Open in Workspace
                            </button>
                        </div>

                        <div className="flex-1 space-y-6 overflow-y-auto p-6">
                            <div className="grid grid-cols-2 gap-3">
                                <div className="rounded border border-outline-variant bg-surface-container-low p-3">
                                    <div className="mb-1 text-[10px] font-semibold uppercase tracking-wider text-slate-500">Source DB</div>
                                    <div className="flex items-center gap-1.5 text-xs font-medium text-on-surface">
                                        <Database size={12} className="text-oxblood" />
                                        <span className="truncate">
                                            {dataSourceNameById[selectedQuery.data_source_id] || 'Unknown source'}
                                        </span>
                                    </div>
                                </div>
                                <div className="rounded border border-outline-variant bg-surface-container-low p-3">
                                    <div className="mb-1 text-[10px] font-semibold uppercase tracking-wider text-slate-500">Last Modified</div>
                                    <div className="text-xs font-medium text-on-surface">{formatDate(selectedQuery.updated_at)}</div>
                                </div>
                                <div className="rounded border border-outline-variant bg-surface-container-low p-3">
                                    <div className="mb-1 text-[10px] font-semibold uppercase tracking-wider text-slate-500">Created</div>
                                    <div className="text-xs font-medium text-on-surface">{formatDate(selectedQuery.created_at)}</div>
                                </div>
                                <div className="rounded border border-outline-variant bg-surface-container-low p-3">
                                    <div className="mb-1 text-[10px] font-semibold uppercase tracking-wider text-slate-500">Owner</div>
                                    <div className="text-xs font-medium text-on-surface">{selectedQuery.owner_id}</div>
                                </div>
                            </div>

                            <div>
                                <div className="mb-2 flex items-end justify-between">
                                    <h3 className="text-sm font-semibold text-on-surface">Query Preview</h3>
                                    <span className="text-[10px] font-semibold uppercase tracking-wider text-slate-500">
                                        {dataSourceTypeById[selectedQuery.data_source_id] || 'sql'}
                                    </span>
                                </div>
                                <div className="overflow-hidden rounded border border-outline-variant bg-white">
                                    <Editor
                                        height="220px"
                                        defaultLanguage={monacoLanguage}
                                        value={selectedQuery.sql}
                                        theme="vs"
                                        options={{
                                            readOnly: true,
                                            minimap: { enabled: false },
                                            fontSize: 12,
                                            scrollBeyondLastLine: false,
                                            wordWrap: 'on',
                                            renderLineHighlight: 'none',
                                            lineNumbers: 'on',
                                        }}
                                    />
                                </div>
                            </div>

                            <div className="border-t border-outline-variant pt-4">
                                <div className="mb-2 text-[10px] font-semibold uppercase tracking-wider text-slate-500">Tags</div>
                                {selectedQuery.tags.length === 0 ? (
                                    <p className="text-xs text-slate-400">No tags assigned.</p>
                                ) : (
                                    <div className="flex flex-wrap gap-1.5">
                                        {selectedQuery.tags.map((tag) => (
                                            <span
                                                key={tag}
                                                className="rounded border border-outline-variant bg-amber-accent/20 px-2 py-0.5 text-[11px] font-medium text-on-secondary-container"
                                            >
                                                #{tag}
                                            </span>
                                        ))}
                                    </div>
                                )}
                            </div>

                            {(selectedQuery.parameter_schema?.length ?? 0) > 0 && (
                                <div className="border-t border-outline-variant pt-4">
                                    <div className="mb-2 text-[10px] font-semibold uppercase tracking-wider text-slate-500">Variables Required</div>
                                    <div className="flex flex-wrap gap-2">
                                        {selectedQuery.parameter_schema.map((param) => (
                                            <span
                                                key={param.name}
                                                className="rounded border border-outline-variant bg-surface-container px-2 py-0.5 font-mono text-[11px] text-on-surface"
                                            >
                                                :{param.name}
                                            </span>
                                        ))}
                                    </div>
                                </div>
                            )}
                        </div>
                    </>
                ) : (
                    <div className="flex h-full flex-col items-center justify-center px-6 text-center text-sm text-slate-500">
                        <FileText size={28} className="mb-3 text-slate-300" />
                        <p className="font-medium text-slate-700">Select a query</p>
                        <p className="mt-1 text-xs">Pick a saved query to preview its SQL and metadata.</p>
                    </div>
                )}
            </aside>

            <SaveQueryDialog
                key={editing?.id ?? 'closed'}
                isOpen={Boolean(editing)}
                mode="edit"
                initial={editing}
                isSubmitting={isSubmittingEdit}
                onClose={() => setEditing(null)}
                onSave={handleSaveEdit}
            />

            {confirmDeleteId && (
                <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
                    <div className="w-full max-w-sm rounded-lg bg-white shadow-xl">
                        <div className="border-b border-outline-variant px-4 py-3">
                            <h3 className="text-sm font-semibold text-on-surface">Delete saved query?</h3>
                        </div>
                        <div className="px-4 py-3 text-xs text-slate-600">
                            This action cannot be undone.
                        </div>
                        <div className="flex justify-end gap-2 border-t border-outline-variant px-4 py-3">
                            <button
                                type="button"
                                onClick={() => setConfirmDeleteId(null)}
                                className="rounded-md border border-outline-variant bg-white px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50"
                            >
                                Cancel
                            </button>
                            <button
                                type="button"
                                onClick={() => void handleDelete(confirmDeleteId)}
                                disabled={pendingId === confirmDeleteId}
                                className="rounded-md bg-red-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-red-700 disabled:cursor-not-allowed disabled:opacity-50"
                            >
                                {pendingId === confirmDeleteId ? 'Deleting…' : 'Delete'}
                            </button>
                        </div>
                    </div>
                </div>
            )}
        </main>
    );
};
