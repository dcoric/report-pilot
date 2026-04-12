import { useState } from 'react';
import { X } from 'lucide-react';
import type { SavedQuery } from './types';

const SAVED_QUERY_NAME_MAX_LENGTH = 200;
const SAVED_QUERY_DESCRIPTION_MAX_LENGTH = 1000;

interface SavedQueryMetadataDialogProps {
    isOpen: boolean;
    savedQuery: SavedQuery | null;
    isSubmitting: boolean;
    onClose: () => void;
    onSave: (values: { name: string; description: string }) => void;
}

export function SavedQueryMetadataDialog({
    isOpen,
    savedQuery,
    isSubmitting,
    onClose,
    onSave,
}: SavedQueryMetadataDialogProps) {
    const [name, setName] = useState(() => savedQuery?.name ?? '');
    const [description, setDescription] = useState(() => savedQuery?.description ?? '');

    if (!isOpen || !savedQuery) {
        return null;
    }

    const handleSubmit = (event: React.FormEvent) => {
        event.preventDefault();
        onSave({
            name: name.trim(),
            description: description.trim(),
        });
    };

    return (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
            <div className="w-full max-w-md overflow-hidden rounded-lg bg-white shadow-xl">
                <div className="flex items-center justify-between border-b border-gray-200 px-4 py-3">
                    <h2 className="text-lg font-semibold text-gray-900">Edit Saved Query</h2>
                    <button
                        type="button"
                        onClick={onClose}
                        className="text-gray-500 hover:text-gray-700"
                        aria-label="Close edit saved query dialog"
                    >
                        <X size={18} />
                    </button>
                </div>

                <form onSubmit={handleSubmit} className="space-y-4 p-4">
                    <div>
                        <label className="mb-1 block text-sm font-medium text-gray-700">Name</label>
                        <input
                            type="text"
                            required
                            maxLength={SAVED_QUERY_NAME_MAX_LENGTH}
                            value={name}
                            onChange={(event) => setName(event.target.value)}
                            className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm focus:border-transparent focus:ring-2 focus:ring-blue-500 focus:outline-none"
                        />
                    </div>

                    <div>
                        <label className="mb-1 block text-sm font-medium text-gray-700">Description</label>
                        <textarea
                            rows={4}
                            maxLength={SAVED_QUERY_DESCRIPTION_MAX_LENGTH}
                            value={description}
                            onChange={(event) => setDescription(event.target.value)}
                            className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm focus:border-transparent focus:ring-2 focus:ring-blue-500 focus:outline-none"
                            placeholder="Optional description"
                        />
                    </div>

                    <div className="flex justify-end gap-2 border-t border-gray-200 pt-4">
                        <button
                            type="button"
                            onClick={onClose}
                            disabled={isSubmitting}
                            className="rounded-md border border-gray-300 bg-white px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50 disabled:cursor-not-allowed disabled:opacity-50"
                        >
                            Cancel
                        </button>
                        <button
                            type="submit"
                            disabled={isSubmitting || !name.trim()}
                            className="rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-50"
                        >
                            {isSubmitting ? 'Saving...' : 'Save'}
                        </button>
                    </div>
                </form>
            </div>
        </div>
    );
}
