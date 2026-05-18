import { useMemo, useState } from 'react';
import {
    ChevronDown,
    ChevronRight,
    FileText,
    FolderClosed,
    FolderOpen,
    FolderPlus,
    Globe,
    Inbox,
    Lock,
    MoreVertical,
    Pencil,
    RefreshCw,
    Search,
    Trash2,
    Library,
} from 'lucide-react';
import type { SavedQuery } from './types';
import type { SavedQueryFolder, SavedQueryFolderTreeNode } from '../../hooks/useSavedQueryFolders';

export type FolderSelection =
    | { kind: 'all' }
    | { kind: 'unfiled' }
    | { kind: 'folder'; folderId: string };

interface SavedQueryTreeProps {
    tree: SavedQueryFolderTreeNode[];
    folders: SavedQueryFolder[];
    savedQueries: SavedQuery[];
    selection: FolderSelection;
    onSelect: (selection: FolderSelection) => void;
    onOpenSavedQuery: (savedQueryId: string) => void;
    onCreateFolder: (parentId: string | null) => void;
    onRenameFolder: (folder: SavedQueryFolder) => void;
    onDeleteFolder: (folder: SavedQueryFolder) => void;
    onMoveSavedQuery: (savedQuery: SavedQuery) => void;
    onRefresh: () => void;
    isLoading?: boolean;
    canWrite: boolean;
}

function countQueriesInSubtree(
    node: SavedQueryFolderTreeNode,
    queriesByFolder: Record<string, SavedQuery[]>,
): number {
    const direct = queriesByFolder[node.id]?.length ?? 0;
    return node.children.reduce((sum, child) => sum + countQueriesInSubtree(child, queriesByFolder), direct);
}

function matchesSearch(saved: SavedQuery, needle: string) {
    if (!needle) return true;
    const haystack = [saved.name, saved.description ?? '', ...(saved.tags ?? [])].join(' ').toLowerCase();
    return haystack.includes(needle);
}

function folderMatchesSearch(folder: SavedQueryFolder, needle: string) {
    if (!needle) return true;
    return folder.name.toLowerCase().includes(needle);
}

function visibleFolderIds(
    tree: SavedQueryFolderTreeNode[],
    queriesByFolder: Record<string, SavedQuery[]>,
    needle: string,
): Set<string> {
    if (!needle) {
        return new Set();
    }
    const visible = new Set<string>();
    const walk = (node: SavedQueryFolderTreeNode): boolean => {
        const childMatches = node.children.map(walk).some(Boolean);
        const hasMatchingQuery = (queriesByFolder[node.id] ?? []).some((entry) => matchesSearch(entry, needle));
        const selfMatch = folderMatchesSearch(node, needle);
        const matched = childMatches || hasMatchingQuery || selfMatch;
        if (matched) {
            visible.add(node.id);
        }
        return matched;
    };
    tree.forEach(walk);
    return visible;
}

interface FolderNodeProps extends SavedQueryTreeProps {
    node: SavedQueryFolderTreeNode;
    depth: number;
    expanded: Set<string>;
    toggleExpanded: (folderId: string) => void;
    queriesByFolder: Record<string, SavedQuery[]>;
    searchNeedle: string;
    matchedFolderIds: Set<string>;
}

function FolderNode(props: FolderNodeProps) {
    const {
        node,
        depth,
        expanded,
        toggleExpanded,
        queriesByFolder,
        selection,
        onSelect,
        onOpenSavedQuery,
        onCreateFolder,
        onRenameFolder,
        onDeleteFolder,
        onMoveSavedQuery,
        searchNeedle,
        matchedFolderIds,
        canWrite,
    } = props;

    const [menuOpen, setMenuOpen] = useState(false);
    const isExpanded = expanded.has(node.id) || (searchNeedle.length > 0 && matchedFolderIds.has(node.id));
    const isSelected = selection.kind === 'folder' && selection.folderId === node.id;
    const directQueries = (queriesByFolder[node.id] ?? []).filter((entry) => matchesSearch(entry, searchNeedle));
    const totalCount = countQueriesInSubtree(node, queriesByFolder);

    const childrenToRender = node.children.filter((child) =>
        searchNeedle ? matchedFolderIds.has(child.id) : true,
    );

    return (
        <div>
            <div
                className={[
                    'group flex items-center gap-1 rounded px-1 py-1 text-xs',
                    isSelected ? 'bg-oxblood/10 text-oxblood' : 'text-on-surface hover:bg-surface-container-low',
                ].join(' ')}
                style={{ paddingLeft: `${depth * 12 + 4}px` }}
            >
                <button
                    type="button"
                    onClick={() => toggleExpanded(node.id)}
                    className="flex h-4 w-4 shrink-0 items-center justify-center text-slate-400 hover:text-slate-700"
                    aria-label={isExpanded ? 'Collapse folder' : 'Expand folder'}
                >
                    {node.children.length > 0 ? (
                        isExpanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />
                    ) : <span className="inline-block h-3 w-3" />}
                </button>
                <button
                    type="button"
                    onClick={() => onSelect({ kind: 'folder', folderId: node.id })}
                    className="flex min-w-0 flex-1 items-center gap-1.5 truncate text-left"
                >
                    {isExpanded ? (
                        <FolderOpen size={13} className={isSelected ? 'text-oxblood' : 'text-amber-accent'} />
                    ) : (
                        <FolderClosed size={13} className={isSelected ? 'text-oxblood' : 'text-amber-accent'} />
                    )}
                    <span className="truncate font-medium">{node.name}</span>
                    {totalCount > 0 && (
                        <span className="text-[10px] text-slate-400">{totalCount}</span>
                    )}
                </button>
                {canWrite && (
                    <div className="relative">
                        <button
                            type="button"
                            onClick={(event) => {
                                event.stopPropagation();
                                setMenuOpen((current) => !current);
                            }}
                            className="rounded p-0.5 text-slate-400 opacity-0 hover:bg-surface-container hover:text-slate-700 group-hover:opacity-100"
                            title="Folder actions"
                            aria-label="Folder actions"
                        >
                            <MoreVertical size={12} />
                        </button>
                        {menuOpen && (
                            <>
                                <div className="fixed inset-0 z-10" onClick={() => setMenuOpen(false)} />
                                <div className="absolute right-0 top-5 z-20 w-44 rounded border border-outline-variant bg-white py-1 text-xs shadow-lg">
                                    <button
                                        type="button"
                                        onClick={() => {
                                            setMenuOpen(false);
                                            onCreateFolder(node.id);
                                        }}
                                        className="flex w-full items-center gap-2 px-3 py-1.5 text-left hover:bg-surface-container-low"
                                    >
                                        <FolderPlus size={12} />
                                        New subfolder
                                    </button>
                                    <button
                                        type="button"
                                        onClick={() => {
                                            setMenuOpen(false);
                                            onRenameFolder(node);
                                        }}
                                        className="flex w-full items-center gap-2 px-3 py-1.5 text-left hover:bg-surface-container-low"
                                    >
                                        <Pencil size={12} />
                                        Rename
                                    </button>
                                    <button
                                        type="button"
                                        onClick={() => {
                                            setMenuOpen(false);
                                            onDeleteFolder(node);
                                        }}
                                        className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-red-600 hover:bg-red-50"
                                    >
                                        <Trash2 size={12} />
                                        Delete
                                    </button>
                                </div>
                            </>
                        )}
                    </div>
                )}
            </div>
            {isExpanded && (
                <div>
                    {childrenToRender.map((child) => (
                        <FolderNode
                            {...props}
                            key={child.id}
                            node={child}
                            depth={depth + 1}
                        />
                    ))}
                    {directQueries.map((entry) => (
                        <SavedQueryLeaf
                            key={entry.id}
                            entry={entry}
                            depth={depth + 1}
                            onOpen={() => onOpenSavedQuery(entry.id)}
                            onMove={() => onMoveSavedQuery(entry)}
                            canWrite={canWrite}
                        />
                    ))}
                </div>
            )}
        </div>
    );
}

interface SavedQueryLeafProps {
    entry: SavedQuery;
    depth: number;
    onOpen: () => void;
    onMove: () => void;
    canWrite: boolean;
}

function SavedQueryLeaf({ entry, depth, onOpen, onMove, canWrite }: SavedQueryLeafProps) {
    const [menuOpen, setMenuOpen] = useState(false);
    return (
        <div
            className="group flex items-center gap-1 rounded px-1 py-1 text-xs text-on-surface hover:bg-surface-container-low"
            style={{ paddingLeft: `${depth * 12 + 20}px` }}
        >
            <button
                type="button"
                onClick={onOpen}
                className="flex min-w-0 flex-1 items-center gap-1.5 truncate text-left"
                title={entry.description || entry.name}
            >
                <FileText size={12} className="shrink-0 text-slate-400" />
                <span className="truncate">{entry.name}</span>
                {entry.visibility === 'shared' ? (
                    <Globe size={9} className="shrink-0 text-emerald-600" />
                ) : (
                    <Lock size={9} className="shrink-0 text-slate-400" />
                )}
            </button>
            {canWrite && (
                <div className="relative">
                    <button
                        type="button"
                        onClick={(event) => {
                            event.stopPropagation();
                            setMenuOpen((current) => !current);
                        }}
                        className="rounded p-0.5 text-slate-400 opacity-0 hover:bg-surface-container hover:text-slate-700 group-hover:opacity-100"
                        title="Query actions"
                        aria-label="Query actions"
                    >
                        <MoreVertical size={12} />
                    </button>
                    {menuOpen && (
                        <>
                            <div className="fixed inset-0 z-10" onClick={() => setMenuOpen(false)} />
                            <div className="absolute right-0 top-5 z-20 w-44 rounded border border-outline-variant bg-white py-1 text-xs shadow-lg">
                                <button
                                    type="button"
                                    onClick={() => {
                                        setMenuOpen(false);
                                        onMove();
                                    }}
                                    className="flex w-full items-center gap-2 px-3 py-1.5 text-left hover:bg-surface-container-low"
                                >
                                    <FolderClosed size={12} />
                                    Move to folder…
                                </button>
                            </div>
                        </>
                    )}
                </div>
            )}
        </div>
    );
}

export function SavedQueryTree(props: SavedQueryTreeProps) {
    const {
        tree,
        savedQueries,
        selection,
        onSelect,
        onOpenSavedQuery,
        onCreateFolder,
        onMoveSavedQuery,
        onRefresh,
        isLoading,
        canWrite,
    } = props;

    const [expanded, setExpanded] = useState<Set<string>>(new Set());
    const [searchText, setSearchText] = useState('');

    const queriesByFolder = useMemo(() => {
        const grouped: Record<string, SavedQuery[]> = {};
        for (const entry of savedQueries) {
            const key = entry.folder_id ?? '__unfiled__';
            (grouped[key] ||= []).push(entry);
        }
        for (const key of Object.keys(grouped)) {
            grouped[key].sort((a, b) => a.name.localeCompare(b.name));
        }
        return grouped;
    }, [savedQueries]);

    const needle = searchText.trim().toLowerCase();
    const matchedFolderIds = useMemo(
        () => visibleFolderIds(tree, queriesByFolder, needle),
        [tree, queriesByFolder, needle],
    );

    const unfiled = (queriesByFolder['__unfiled__'] ?? []).filter((entry) => matchesSearch(entry, needle));
    const totalQueries = savedQueries.length;

    function toggleExpanded(folderId: string) {
        setExpanded((current) => {
            const next = new Set(current);
            if (next.has(folderId)) {
                next.delete(folderId);
            } else {
                next.add(folderId);
            }
            return next;
        });
    }

    const visibleTree = needle
        ? tree.filter((node) => matchedFolderIds.has(node.id))
        : tree;

    return (
        <div className="flex h-full flex-col bg-white">
            <div className="shrink-0 border-b border-outline-variant px-3 py-3">
                <div className="mb-2 flex items-center justify-between">
                    <h2 className="text-[11px] font-semibold uppercase tracking-wider text-slate-500">Library</h2>
                    <div className="flex items-center gap-1">
                        {canWrite && (
                            <button
                                type="button"
                                onClick={() => onCreateFolder(null)}
                                className="rounded p-1 text-slate-500 hover:bg-surface-container-low hover:text-on-surface"
                                title="New folder"
                                aria-label="New folder"
                            >
                                <FolderPlus size={14} />
                            </button>
                        )}
                        <button
                            type="button"
                            onClick={onRefresh}
                            className="rounded p-1 text-slate-500 hover:bg-surface-container-low hover:text-on-surface"
                            title="Refresh"
                            aria-label="Refresh folders"
                        >
                            <RefreshCw size={14} className={isLoading ? 'animate-spin' : undefined} />
                        </button>
                    </div>
                </div>
                <div className="relative">
                    <Search size={12} className="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 text-slate-400" />
                    <input
                        type="text"
                        value={searchText}
                        onChange={(event) => setSearchText(event.target.value)}
                        placeholder="Search folders & queries"
                        className="w-full rounded border border-outline-variant bg-surface-container-low py-1 pl-6 pr-2 text-xs text-on-surface placeholder-slate-400 focus:border-oxblood focus:outline-none focus:ring-1 focus:ring-oxblood"
                    />
                </div>
            </div>
            <div className="flex-1 overflow-y-auto px-2 py-2 text-xs">
                <button
                    type="button"
                    onClick={() => onSelect({ kind: 'all' })}
                    className={[
                        'mb-0.5 flex w-full items-center gap-2 rounded px-2 py-1 text-left',
                        selection.kind === 'all'
                            ? 'bg-oxblood/10 text-oxblood'
                            : 'text-on-surface hover:bg-surface-container-low',
                    ].join(' ')}
                >
                    <Library size={13} />
                    <span className="flex-1 truncate font-medium">All queries</span>
                    <span className="text-[10px] text-slate-400">{totalQueries}</span>
                </button>
                <button
                    type="button"
                    onClick={() => onSelect({ kind: 'unfiled' })}
                    className={[
                        'mb-1 flex w-full items-center gap-2 rounded px-2 py-1 text-left',
                        selection.kind === 'unfiled'
                            ? 'bg-oxblood/10 text-oxblood'
                            : 'text-on-surface hover:bg-surface-container-low',
                    ].join(' ')}
                >
                    <Inbox size={13} />
                    <span className="flex-1 truncate font-medium">Unfiled</span>
                    <span className="text-[10px] text-slate-400">{queriesByFolder['__unfiled__']?.length ?? 0}</span>
                </button>

                {selection.kind === 'unfiled' && unfiled.length > 0 && (
                    <div className="mb-2">
                        {unfiled.map((entry) => (
                            <SavedQueryLeaf
                                key={entry.id}
                                entry={entry}
                                depth={1}
                                onOpen={() => onOpenSavedQuery(entry.id)}
                                onMove={() => onMoveSavedQuery(entry)}
                                canWrite={canWrite}
                            />
                        ))}
                    </div>
                )}

                {visibleTree.length === 0 && tree.length === 0 && !isLoading && (
                    <div className="px-2 py-6 text-center text-[11px] text-slate-400">
                        No folders yet.
                        {canWrite && (
                            <>
                                <br />
                                <button
                                    type="button"
                                    onClick={() => onCreateFolder(null)}
                                    className="mt-2 inline-flex items-center gap-1 text-oxblood hover:underline"
                                >
                                    <FolderPlus size={11} />
                                    Create one
                                </button>
                            </>
                        )}
                    </div>
                )}

                {visibleTree.map((node) => (
                    <FolderNode
                        {...props}
                        key={node.id}
                        node={node}
                        depth={0}
                        expanded={expanded}
                        toggleExpanded={toggleExpanded}
                        queriesByFolder={queriesByFolder}
                        searchNeedle={needle}
                        matchedFolderIds={matchedFolderIds}
                    />
                ))}
            </div>
        </div>
    );
}
