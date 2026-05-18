import { useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';
import { client } from '../lib/api/client';
import type { components } from '../lib/api/types';

export type SavedQueryFolder = components['schemas']['SavedQueryFolder'];
export type SavedQueryFolderTreeNode = components['schemas']['SavedQueryFolderTreeNode'];

export const SAVED_QUERY_FOLDER_NAME_MAX_LENGTH = 200;

export interface UseSavedQueryFoldersResult {
    folders: SavedQueryFolder[];
    tree: SavedQueryFolderTreeNode[];
    foldersById: Record<string, SavedQueryFolder>;
    isLoading: boolean;
    errorMessage: string | null;
    refresh: () => Promise<void>;
    createFolder: (input: { name: string; parentId?: string | null }) => Promise<SavedQueryFolder | null>;
    renameFolder: (folderId: string, name: string) => Promise<SavedQueryFolder | null>;
    moveFolder: (folderId: string, parentId: string | null) => Promise<SavedQueryFolder | null>;
    deleteFolder: (folderId: string) => Promise<boolean>;
    moveSavedQuery: (
        savedQueryId: string,
        folderId: string | null,
    ) => Promise<components['schemas']['MoveSavedQueryResponse'] | null>;
}

function sortFolders(items: SavedQueryFolder[]) {
    return [...items].sort((left, right) => left.name.localeCompare(right.name));
}

// Folder endpoints don't declare error response schemas in the OpenAPI spec, so
// openapi-fetch types `error` as `never`. The server still returns a JSON error
// payload — read it defensively at runtime.
function extractErrorMessage(error: unknown, fallback: string): string {
    if (error && typeof error === 'object' && 'message' in error) {
        const message = (error as { message?: unknown }).message;
        if (typeof message === 'string' && message.length > 0) {
            return message;
        }
    }
    return fallback;
}

export function useSavedQueryFolders(): UseSavedQueryFoldersResult {
    const [folders, setFolders] = useState<SavedQueryFolder[]>([]);
    const [tree, setTree] = useState<SavedQueryFolderTreeNode[]>([]);
    const [isLoading, setIsLoading] = useState(true);
    const [errorMessage, setErrorMessage] = useState<string | null>(null);

    const refresh = useCallback(async () => {
        setIsLoading(true);
        setErrorMessage(null);
        try {
            const { data, error } = await client.GET('/v1/saved-query-folders');
            if (error || !data) {
                setErrorMessage('Failed to load folders.');
                return;
            }
            setFolders(sortFolders(data.items ?? []));
            setTree(data.tree ?? []);
        } catch (error) {
            console.error('Failed to fetch folders', error);
            setErrorMessage('Failed to load folders.');
        } finally {
            setIsLoading(false);
        }
    }, []);

    useEffect(() => {
        void refresh();
    }, [refresh]);

    const createFolder = useCallback<UseSavedQueryFoldersResult['createFolder']>(async ({ name, parentId = null }) => {
        try {
            const { data, error } = await client.POST('/v1/saved-query-folders', {
                body: { name, parent_id: parentId },
            });
            if (error || !data) {
                toast.error(extractErrorMessage(error, 'Failed to create folder.'));
                return null;
            }
            await refresh();
            return data;
        } catch (error) {
            console.error('Failed to create folder', error);
            toast.error('Failed to create folder.');
            return null;
        }
    }, [refresh]);

    const renameFolder = useCallback<UseSavedQueryFoldersResult['renameFolder']>(async (folderId, name) => {
        try {
            const { data, error } = await client.PUT('/v1/saved-query-folders/{folderId}', {
                params: { path: { folderId } },
                body: { name },
            });
            if (error || !data) {
                toast.error(extractErrorMessage(error, 'Failed to rename folder.'));
                return null;
            }
            setFolders((current) => sortFolders(current.map((item) => (item.id === data.id ? data : item))));
            await refresh();
            return data;
        } catch (error) {
            console.error('Failed to rename folder', error);
            toast.error('Failed to rename folder.');
            return null;
        }
    }, [refresh]);

    const moveFolder = useCallback<UseSavedQueryFoldersResult['moveFolder']>(async (folderId, parentId) => {
        try {
            const { data, error } = await client.PUT('/v1/saved-query-folders/{folderId}', {
                params: { path: { folderId } },
                body: { parent_id: parentId },
            });
            if (error || !data) {
                toast.error(extractErrorMessage(error, 'Failed to move folder.'));
                return null;
            }
            await refresh();
            return data;
        } catch (error) {
            console.error('Failed to move folder', error);
            toast.error('Failed to move folder.');
            return null;
        }
    }, [refresh]);

    const deleteFolder = useCallback<UseSavedQueryFoldersResult['deleteFolder']>(async (folderId) => {
        try {
            const { data, error } = await client.DELETE('/v1/saved-query-folders/{folderId}', {
                params: { path: { folderId } },
            });
            if (error || !data?.ok) {
                toast.error(extractErrorMessage(error, 'Failed to delete folder.'));
                return false;
            }
            await refresh();
            return true;
        } catch (error) {
            console.error('Failed to delete folder', error);
            toast.error('Failed to delete folder.');
            return false;
        }
    }, [refresh]);

    const moveSavedQuery = useCallback<UseSavedQueryFoldersResult['moveSavedQuery']>(async (savedQueryId, folderId) => {
        try {
            const { data, error } = await client.POST('/v1/saved-queries/{savedQueryId}/move', {
                params: { path: { savedQueryId } },
                body: { folder_id: folderId },
            });
            if (error || !data) {
                toast.error(extractErrorMessage(error, 'Failed to move saved query.'));
                return null;
            }
            return data;
        } catch (error) {
            console.error('Failed to move saved query', error);
            toast.error('Failed to move saved query.');
            return null;
        }
    }, []);

    const foldersById = folders.reduce<Record<string, SavedQueryFolder>>((acc, folder) => {
        acc[folder.id] = folder;
        return acc;
    }, {});

    return {
        folders,
        tree,
        foldersById,
        isLoading,
        errorMessage,
        refresh,
        createFolder,
        renameFolder,
        moveFolder,
        deleteFolder,
        moveSavedQuery,
    };
}
