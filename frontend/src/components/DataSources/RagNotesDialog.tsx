import React, { useCallback, useEffect, useState } from 'react';
import { FileText, Loader2, Pencil, Plus, Trash2, X } from 'lucide-react';
import { toast } from 'sonner';
import { client } from '../../lib/api/client';
import type { components } from '../../lib/api/types';

type RagNote = components['schemas']['RagNoteResponse'];

interface RagNotesDialogProps {
    isOpen: boolean;
    dataSourceId: string | null;
    dataSourceName?: string | null;
    onClose: () => void;
}

export const RagNotesDialog: React.FC<RagNotesDialogProps> = ({
    isOpen,
    dataSourceId,
    dataSourceName,
    onClose
}) => {
    const [items, setItems] = useState<RagNote[]>([]);
    const [isLoading, setIsLoading] = useState(false);
    const [loadError, setLoadError] = useState<string | null>(null);
    const [isSaving, setIsSaving] = useState(false);
    const [editingId, setEditingId] = useState<string | null>(null);
    const [title, setTitle] = useState('');
    const [content, setContent] = useState('');

    const resetForm = () => {
        setEditingId(null);
        setTitle('');
        setContent('');
    };

    const loadNotes = useCallback(async () => {
        if (!dataSourceId) return;
        setIsLoading(true);
        setLoadError(null);

        try {
            const { data, error } = await client.GET('/v1/rag/notes', {
                params: {
                    query: {
                        data_source_id: dataSourceId
                    }
                }
            });

            if (error) {
                setLoadError('Failed to load RAG notes.');
                return;
            }

            setItems(data?.items || []);
        } catch (err) {
            console.error(err);
            setLoadError('Failed to load RAG notes.');
        } finally {
            setIsLoading(false);
        }
    }, [dataSourceId]);

    useEffect(() => {
        if (!isOpen || !dataSourceId) {
            return;
        }
        resetForm();
        void loadNotes();
    }, [isOpen, dataSourceId, loadNotes]);

    if (!isOpen || !dataSourceId) {
        return null;
    }

    const handleEdit = (note: RagNote) => {
        setEditingId(note.id);
        setTitle(note.title);
        setContent(note.content);
    };

    const handleSave = async (e: React.FormEvent) => {
        e.preventDefault();

        const trimmedTitle = title.trim();
        const trimmedContent = content.trim();

        if (!trimmedTitle || !trimmedContent) {
            toast.error('Title and content are required.');
            return;
        }
        if (trimmedTitle.length > 200) {
            toast.error('Title cannot exceed 200 characters.');
            return;
        }
        if (trimmedContent.length > 20000) {
            toast.error('Content cannot exceed 20,000 characters.');
            return;
        }

        setIsSaving(true);
        try {
            const { data, error } = await client.POST('/v1/rag/notes', {
                body: {
                    ...(editingId ? { id: editingId } : {}),
                    data_source_id: dataSourceId,
                    title: trimmedTitle,
                    content: trimmedContent
                }
            });

            if (error || !data) {
                return;
            }

            toast.success(editingId ? 'RAG note updated.' : 'RAG note created.');
            resetForm();
            await loadNotes();
        } catch (err) {
            console.error(err);
            toast.error('Failed to save RAG note.');
        } finally {
            setIsSaving(false);
        }
    };

    const handleDelete = async (note: RagNote) => {
        const confirmed = window.confirm(`Delete note "${note.title}"?`);
        if (!confirmed) {
            return;
        }

        try {
            const { error } = await client.DELETE('/v1/rag/notes/{noteId}', {
                params: {
                    path: {
                        noteId: note.id
                    }
                }
            });

            if (error) {
                return;
            }

            if (editingId === note.id) {
                resetForm();
            }
            toast.success('RAG note deleted.');
            await loadNotes();
        } catch (err) {
            console.error(err);
            toast.error('Failed to delete RAG note.');
        }
    };

    return (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black bg-opacity-50 p-4">
            <div className="bg-white rounded-lg shadow-xl w-full max-w-5xl overflow-hidden max-h-[90vh] flex flex-col">
                <div className="flex items-center justify-between border-b p-4">
                    <div>
                        <h2 className="text-lg font-semibold">RAG Notes</h2>
                        <p className="text-sm text-gray-500">
                            {dataSourceName ? `${dataSourceName}: ` : ''}manual context for SQL generation.
                        </p>
                    </div>
                    <button onClick={onClose} className="text-gray-500 hover:text-gray-700" aria-label="Close RAG notes dialog">
                        <X size={20} />
                    </button>
                </div>

                <div className="grid grid-cols-1 md:grid-cols-2 gap-0 min-h-[520px] flex-1 overflow-hidden">
                    <div className="border-r border-gray-200 p-4 min-h-0 overflow-y-auto">
                        <div className="flex items-center justify-between mb-3">
                            <h3 className="font-medium text-gray-900">Notes</h3>
                            <button
                                onClick={resetForm}
                                className="inline-flex items-center gap-1 text-sm px-2 py-1 rounded bg-blue-50 text-blue-700 hover:bg-blue-100"
                            >
                                <Plus size={14} />
                                New
                            </button>
                        </div>

                        {isLoading ? (
                            <div className="h-44 flex items-center justify-center text-gray-500">
                                <Loader2 className="animate-spin mr-2" size={16} />
                                Loading notes...
                            </div>
                        ) : loadError ? (
                            <div className="h-44 flex flex-col items-center justify-center text-center text-red-600 gap-2">
                                <p>{loadError}</p>
                                <button className="text-sm text-blue-600 hover:underline" onClick={() => void loadNotes()}>
                                    Retry
                                </button>
                            </div>
                        ) : items.length === 0 ? (
                            <div className="h-44 flex flex-col items-center justify-center text-gray-500 text-center">
                                <FileText className="mb-2 opacity-30" size={28} />
                                <p>No notes yet.</p>
                                <p className="text-xs mt-1">Create notes for business rules, caveats, and reporting guidance.</p>
                            </div>
                        ) : (
                            <div className="space-y-2 max-h-[420px] overflow-y-auto pr-1">
                                {items.map((note) => (
                                    <div key={note.id} className="border rounded-md p-3 bg-gray-50">
                                        <div className="flex items-start justify-between gap-2">
                                            <div className="min-w-0">
                                                <p className="font-medium text-sm text-gray-900 truncate">{note.title}</p>
                                                <p className="text-xs text-gray-500 mt-1 line-clamp-3">
                                                    {note.content}
                                                </p>
                                            </div>
                                            <div className="flex items-center gap-1 shrink-0">
                                                <button
                                                    onClick={() => handleEdit(note)}
                                                    className="text-gray-500 hover:text-blue-600"
                                                    title="Edit note"
                                                >
                                                    <Pencil size={14} />
                                                </button>
                                                <button
                                                    onClick={() => void handleDelete(note)}
                                                    className="text-gray-500 hover:text-red-600"
                                                    title="Delete note"
                                                >
                                                    <Trash2 size={14} />
                                                </button>
                                            </div>
                                        </div>
                                    </div>
                                ))}
                            </div>
                        )}
                    </div>

                    <div className="p-4 min-h-0 overflow-y-auto">
                        <h3 className="font-medium text-gray-900 mb-3">
                            {editingId ? 'Edit note' : 'Create note'}
                        </h3>

                        <form id="rag-notes-form" onSubmit={handleSave} className="flex flex-col gap-3 h-full">
                            <div className="flex-1">
                                <label className="block text-sm font-medium text-gray-700 mb-1">Title</label>
                                <input
                                    type="text"
                                    maxLength={200}
                                    value={title}
                                    onChange={(e) => setTitle(e.target.value)}
                                    placeholder="e.g. Revenue policy assumptions"
                                    className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                                />
                            </div>

                            <div className="flex-1 flex flex-col">
                                <label className="block text-sm font-medium text-gray-700 mb-1">Content</label>
                                <textarea
                                    value={content}
                                    onChange={(e) => setContent(e.target.value)}
                                    maxLength={20000}
                                    placeholder="Plain text instructions and constraints for the assistant."
                                    className="w-full min-h-[240px] rounded-md border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                                />
                                <p className="text-xs text-gray-500 mt-2">
                                    Reindexing runs automatically after create, update, or delete.
                                </p>
                            </div>
                        </form>
                    </div>
                </div>

                <div className="border-t p-4 flex items-center justify-between bg-gray-50">
                    <p className="text-xs text-gray-500">Buttons stay anchored while content scrolls.</p>
                    <div className="flex items-center gap-2">
                        <button
                            type="button"
                            onClick={onClose}
                            className="px-3 py-2 text-sm bg-white text-gray-700 border border-gray-300 rounded hover:bg-gray-100"
                            disabled={isSaving}
                        >
                            Close
                        </button>
                        {editingId ? (
                            <button
                                type="button"
                                onClick={resetForm}
                                className="px-3 py-2 text-sm bg-gray-100 text-gray-700 rounded hover:bg-gray-200"
                                disabled={isSaving}
                            >
                                Cancel edit
                            </button>
                        ) : null}
                        <button
                            form="rag-notes-form"
                            type="submit"
                            disabled={isSaving}
                            className="px-3 py-2 text-sm bg-blue-600 text-white rounded hover:bg-blue-700 disabled:opacity-60"
                        >
                            {isSaving ? 'Saving...' : editingId ? 'Update note' : 'Create note'}
                        </button>
                    </div>
                </div>
            </div>
        </div>
    );
};
