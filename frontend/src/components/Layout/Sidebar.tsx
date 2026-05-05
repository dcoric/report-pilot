import { useCallback, useEffect, useMemo, useState } from 'react';
import { format } from 'date-fns';
import {
    ChevronDown,
    ChevronRight,
    Copy,
    Database,
    FileText,
    Loader2,
    Pencil,
    Play,
    RefreshCw,
    Search,
    Trash2,
} from 'lucide-react';
import { toast } from 'sonner';
import { client } from '../../lib/api/client';
import type { components } from '../../lib/api/types';
import { SavedQueryMetadataDialog } from '../Query/SavedQueryMetadataDialog';
import type { SavedQuery } from '../Query/types';

const SAVED_QUERY_NAME_MAX_LENGTH = 200;

type DataSource = components['schemas']['DataSourceListResponse']['items'][number];
type SavedQueryFilter = 'current' | 'all';

interface SidebarProps {
    dataSources: DataSource[];
    selectedDataSourceId: string;
    loadedSavedQueryId: string | null;
    onLoadSavedQuery: (savedQuery: SavedQuery) => void;
    onLoadedSavedQueryDeleted: (savedQueryId: string) => void;
}

function sortSavedQueries(items: SavedQuery[]) {
    return [...items].sort((left, right) => {
        const updatedDiff = new Date(right.updated_at).getTime() - new Date(left.updated_at).getTime();
        if (updatedDiff !== 0) {
            return updatedDiff;
        }

        return new Date(right.created_at).getTime() - new Date(left.created_at).getTime();
    });
}

function buildDuplicateName(baseName: string, attempt: number) {
    const suffix = attempt === 1 ? ' Copy' : ` Copy ${attempt}`;
    const trimmedBase = baseName.trim() || 'Untitled query';
    const prefix = trimmedBase.slice(0, Math.max(1, SAVED_QUERY_NAME_MAX_LENGTH - suffix.length)).trimEnd();
    return `${prefix}${suffix}`;
}

export function Sidebar({
    dataSources,
    selectedDataSourceId,
    loadedSavedQueryId,
    onLoadSavedQuery,
    onLoadedSavedQueryDeleted,
}: SidebarProps) {
    const [isSavedReportsExpanded, setIsSavedReportsExpanded] = useState(true);
    const [savedQueries, setSavedQueries] = useState<SavedQuery[]>([]);
    const [isLoading, setIsLoading] = useState(true);
    const [errorMessage, setErrorMessage] = useState<string | null>(null);
    const [searchQuery, setSearchQuery] = useState('');
    const [filter, setFilter] = useState<SavedQueryFilter>('current');
    const [editingSavedQuery, setEditingSavedQuery] = useState<SavedQuery | null>(null);
    const [isSavingMetadata, setIsSavingMetadata] = useState(false);
    const [deleteConfirmId, setDeleteConfirmId] = useState<string | null>(null);
    const [duplicatingIds, setDuplicatingIds] = useState<Set<string>>(new Set());
    const [deletingIds, setDeletingIds] = useState<Set<string>>(new Set());

    const dataSourceNameById = useMemo(
        () => Object.fromEntries(dataSources.map((dataSource) => [dataSource.id, dataSource.name])),
        [dataSources],
    );

    const fetchSavedQueries = useCallback(async () => {
        setIsLoading(true);
        setErrorMessage(null);

        try {
            const { data, error } = await client.GET('/v1/saved-queries');
            if (error) {
                setErrorMessage('Failed to load saved queries.');
                return;
            }

            setSavedQueries(sortSavedQueries(data?.items ?? []));
        } catch (error) {
            console.error('Failed to fetch saved queries', error);
            setErrorMessage('Failed to load saved queries.');
        } finally {
            setIsLoading(false);
        }
    }, []);

    useEffect(() => {
        void fetchSavedQueries();
    }, [fetchSavedQueries]);

    const visibleSavedQueries = useMemo(() => {
        const normalizedSearch = searchQuery.trim().toLowerCase();
        const shouldFilterByCurrent = filter === 'current' && selectedDataSourceId;

        return savedQueries.filter((savedQuery) => {
            if (shouldFilterByCurrent && savedQuery.data_source_id !== selectedDataSourceId) {
                return false;
            }

            if (!normalizedSearch) {
                return true;
            }

            const nameMatch = savedQuery.name.toLowerCase().includes(normalizedSearch);
            const descriptionMatch = savedQuery.description?.toLowerCase().includes(normalizedSearch) ?? false;
            return nameMatch || descriptionMatch;
        });
    }, [filter, savedQueries, searchQuery, selectedDataSourceId]);

    const handleMetadataSave = async (values: { name: string; description: string }) => {
        if (!editingSavedQuery) {
            return;
        }

        setIsSavingMetadata(true);
        try {
            const { data, error } = await client.PUT('/v1/saved-queries/{savedQueryId}', {
                params: { path: { savedQueryId: editingSavedQuery.id } },
                body: {
                    name: values.name,
                    description: values.description || undefined,
                    data_source_id: editingSavedQuery.data_source_id,
                    sql: editingSavedQuery.sql,
                    default_run_params: editingSavedQuery.default_run_params,
                    parameter_schema: editingSavedQuery.parameter_schema,
                },
            });

            if (error || !data) {
                toast.error(error?.message || 'Failed to update saved query.');
                return;
            }

            setSavedQueries((current) => sortSavedQueries(current.map((item) => (
                item.id === data.id ? data : item
            ))));
            setEditingSavedQuery(null);
            toast.success('Saved query updated.');
        } catch (error) {
            console.error('Failed to update saved query', error);
            toast.error('Failed to update saved query.');
        } finally {
            setIsSavingMetadata(false);
        }
    };

    const handleDuplicate = async (savedQuery: SavedQuery) => {
        if (duplicatingIds.has(savedQuery.id)) {
            return;
        }

        setDuplicatingIds((current) => new Set(current).add(savedQuery.id));
        try {
            for (let attempt = 1; attempt <= 25; attempt += 1) {
                const nextName = buildDuplicateName(savedQuery.name, attempt);
                const { data, response, error } = await client.POST('/v1/saved-queries', {
                    body: {
                        name: nextName,
                        description: savedQuery.description || undefined,
                        data_source_id: savedQuery.data_source_id,
                        sql: savedQuery.sql,
                        default_run_params: savedQuery.default_run_params,
                        parameter_schema: savedQuery.parameter_schema,
                    },
                });

                if (data) {
                    setSavedQueries((current) => sortSavedQueries([data, ...current]));
                    toast.success(`Duplicated as "${data.name}".`);
                    return;
                }

                if (response.status === 409) {
                    continue;
                }

                toast.error(error?.message || 'Failed to duplicate saved query.');
                return;
            }

            toast.error('Could not find an available duplicate name.');
        } catch (error) {
            console.error('Failed to duplicate saved query', error);
            toast.error('Failed to duplicate saved query.');
        } finally {
            setDuplicatingIds((current) => {
                const next = new Set(current);
                next.delete(savedQuery.id);
                return next;
            });
        }
    };

    const handleDelete = async (savedQuery: SavedQuery) => {
        if (deletingIds.has(savedQuery.id)) {
            return;
        }

        setDeletingIds((current) => new Set(current).add(savedQuery.id));
        try {
            const { data, error } = await client.DELETE('/v1/saved-queries/{savedQueryId}', {
                params: { path: { savedQueryId: savedQuery.id } },
            });

            if (error || !data?.ok) {
                toast.error(error?.message || 'Failed to delete saved query.');
                return;
            }

            setSavedQueries((current) => current.filter((item) => item.id !== savedQuery.id));
            setDeleteConfirmId(null);
            if (loadedSavedQueryId === savedQuery.id) {
                onLoadedSavedQueryDeleted(savedQuery.id);
            }
            toast.success('Saved query deleted.');
        } catch (error) {
            console.error('Failed to delete saved query', error);
            toast.error('Failed to delete saved query.');
        } finally {
            setDeletingIds((current) => {
                const next = new Set(current);
                next.delete(savedQuery.id);
                return next;
            });
        }
    };

    const renderContent = () => {
        if (isLoading) {
            return (
                <div className="flex flex-col items-center justify-center px-4 py-10 text-center text-sm text-gray-500">
                    <Loader2 size={18} className="mb-2 animate-spin" />
                    <p>Loading saved queries...</p>
                </div>
            );
        }

        if (errorMessage) {
            return (
                <div className="space-y-3 rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-700">
                    <p>{errorMessage}</p>
                    <button
                        type="button"
                        onClick={() => void fetchSavedQueries()}
                        className="inline-flex items-center gap-1 rounded-md border border-red-200 bg-white px-2 py-1 text-xs font-medium text-red-700 hover:bg-red-100"
                    >
                        <RefreshCw size={12} />
                        Retry
                    </button>
                </div>
            );
        }

        if (savedQueries.length === 0) {
            return (
                <div className="flex flex-col items-center justify-center px-4 py-10 text-center text-sm text-gray-500">
                    <FileText size={28} className="mb-3 text-gray-300" />
                    <p className="font-medium text-gray-700">No saved queries yet</p>
                    <p className="mt-1 text-xs text-gray-500">Saved queries will appear here once created.</p>
                </div>
            );
        }

        if (visibleSavedQueries.length === 0) {
            return (
                <div className="flex flex-col items-center justify-center px-4 py-10 text-center text-sm text-gray-500">
                    <Search size={24} className="mb-3 text-gray-300" />
                    <p className="font-medium text-gray-700">No matches found</p>
                    <p className="mt-1 text-xs text-gray-500">Adjust the search text or switch the filter.</p>
                </div>
            );
        }

        return (
            <div className="space-y-2 px-2 pb-2">
                {visibleSavedQueries.map((savedQuery) => {
                    const isLoaded = loadedSavedQueryId === savedQuery.id;
                    const isDuplicating = duplicatingIds.has(savedQuery.id);
                    const isDeleting = deletingIds.has(savedQuery.id);

                    return (
                        <div
                            key={savedQuery.id}
                            className={`rounded-md border p-2 transition ${
                                isLoaded ? 'border-blue-300 bg-blue-50 shadow-sm' : 'border-gray-200 bg-white hover:border-gray-300'
                            }`}
                        >
                            <button
                                type="button"
                                onClick={() => onLoadSavedQuery(savedQuery)}
                                className="w-full text-left"
                            >
                                <div className="flex items-start justify-between gap-2">
                                    <div className="min-w-0">
                                        <div className="truncate text-sm font-medium text-gray-900">{savedQuery.name}</div>
                                        {savedQuery.description && (
                                            <p className="mt-1 line-clamp-2 text-xs text-gray-600">{savedQuery.description}</p>
                                        )}
                                    </div>
                                    {isLoaded && (
                                        <span className="rounded-full bg-blue-100 px-2 py-0.5 text-[10px] font-semibold tracking-wide text-blue-700 uppercase">
                                            Loaded
                                        </span>
                                    )}
                                </div>

                                <div className="mt-2 flex items-center gap-1 text-[11px] text-gray-500">
                                    <Database size={11} />
                                    <span className="truncate">{dataSourceNameById[savedQuery.data_source_id] || 'Unknown data source'}</span>
                                </div>
                                <div className="mt-1 text-[11px] text-gray-500">
                                    Updated {format(new Date(savedQuery.updated_at), 'MMM d, yyyy')}
                                </div>
                            </button>

                            {deleteConfirmId === savedQuery.id ? (
                                <div className="mt-3 rounded-md border border-red-200 bg-red-50 p-2">
                                    <p className="text-xs text-red-700">Delete this saved query?</p>
                                    <div className="mt-2 flex items-center gap-2">
                                        <button
                                            type="button"
                                            onClick={() => void handleDelete(savedQuery)}
                                            disabled={isDeleting}
                                            className="rounded bg-red-600 px-2 py-1 text-xs font-medium text-white hover:bg-red-700 disabled:cursor-not-allowed disabled:opacity-50"
                                        >
                                            {isDeleting ? 'Deleting...' : 'Confirm'}
                                        </button>
                                        <button
                                            type="button"
                                            onClick={() => setDeleteConfirmId(null)}
                                            disabled={isDeleting}
                                            className="rounded border border-red-200 bg-white px-2 py-1 text-xs font-medium text-red-700 hover:bg-red-100 disabled:cursor-not-allowed disabled:opacity-50"
                                        >
                                            Cancel
                                        </button>
                                    </div>
                                </div>
                            ) : (
                                <div className="mt-3 flex items-center justify-between gap-2">
                                    <button
                                        type="button"
                                        onClick={() => onLoadSavedQuery(savedQuery)}
                                        className="inline-flex items-center gap-1 rounded-md bg-blue-600 px-2 py-1 text-xs font-medium text-white hover:bg-blue-700"
                                    >
                                        <Play size={12} />
                                        Load
                                    </button>

                                    <div className="flex items-center gap-1">
                                        <button
                                            type="button"
                                            onClick={() => setEditingSavedQuery(savedQuery)}
                                            className="rounded p-1 text-gray-500 hover:bg-gray-100 hover:text-blue-700"
                                            title="Edit metadata"
                                            aria-label={`Edit metadata for ${savedQuery.name}`}
                                        >
                                            <Pencil size={13} />
                                        </button>
                                        <button
                                            type="button"
                                            onClick={() => void handleDuplicate(savedQuery)}
                                            disabled={isDuplicating}
                                            className="rounded p-1 text-gray-500 hover:bg-gray-100 hover:text-gray-700 disabled:cursor-not-allowed disabled:opacity-50"
                                            title="Duplicate"
                                            aria-label={`Duplicate ${savedQuery.name}`}
                                        >
                                            {isDuplicating ? <Loader2 size={13} className="animate-spin" /> : <Copy size={13} />}
                                        </button>
                                        <button
                                            type="button"
                                            onClick={() => setDeleteConfirmId(savedQuery.id)}
                                            className="rounded p-1 text-gray-500 hover:bg-red-50 hover:text-red-700"
                                            title="Delete"
                                            aria-label={`Delete ${savedQuery.name}`}
                                        >
                                            <Trash2 size={13} />
                                        </button>
                                    </div>
                                </div>
                            )}
                        </div>
                    );
                })}
            </div>
        );
    };

    return (
        <>
            <div className="flex h-full w-80 flex-col border-l border-gray-200 bg-gray-50">
                <div className="flex-1 overflow-y-auto py-2">
                    <div className="mb-2 px-3">
                        <button
                            type="button"
                            onClick={() => setIsSavedReportsExpanded((current) => !current)}
                            className="flex w-full items-center gap-1 text-xs font-semibold tracking-wider text-gray-500 uppercase hover:text-gray-700"
                        >
                            {isSavedReportsExpanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                            Saved Queries
                        </button>
                    </div>

                    {isSavedReportsExpanded && (
                        <div className="space-y-3 px-3">
                            <div className="space-y-2 rounded-md border border-gray-200 bg-white p-2">
                                <div className="relative">
                                    <Search size={14} className="pointer-events-none absolute top-1/2 left-2 -translate-y-1/2 text-gray-400" />
                                    <input
                                        type="text"
                                        value={searchQuery}
                                        onChange={(event) => setSearchQuery(event.target.value)}
                                        placeholder="Search saved queries"
                                        className="w-full rounded-md border border-gray-300 py-1.5 pr-3 pl-8 text-xs focus:border-transparent focus:ring-2 focus:ring-blue-500 focus:outline-none"
                                    />
                                </div>
                                <div className="flex items-center gap-2">
                                    <select
                                        value={filter}
                                        onChange={(event) => setFilter(event.target.value as SavedQueryFilter)}
                                        className="flex-1 rounded-md border border-gray-300 px-2 py-1.5 text-xs focus:border-transparent focus:ring-2 focus:ring-blue-500 focus:outline-none"
                                    >
                                        <option value="current">Current data source</option>
                                        <option value="all">All data sources</option>
                                    </select>
                                    <button
                                        type="button"
                                        onClick={() => void fetchSavedQueries()}
                                        className="rounded-md border border-gray-300 bg-white p-1.5 text-gray-600 hover:bg-gray-50 hover:text-gray-800"
                                        title="Refresh saved queries"
                                        aria-label="Refresh saved queries"
                                    >
                                        <RefreshCw size={14} />
                                    </button>
                                </div>
                            </div>

                            {renderContent()}
                        </div>
                    )}
                </div>
            </div>

            <SavedQueryMetadataDialog
                key={editingSavedQuery?.id ?? 'closed'}
                isOpen={Boolean(editingSavedQuery)}
                savedQuery={editingSavedQuery}
                isSubmitting={isSavingMetadata}
                onClose={() => setEditingSavedQuery(null)}
                onSave={(values) => void handleMetadataSave(values)}
            />
        </>
    );
}
