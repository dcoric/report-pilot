import { useState } from 'react';
import { Loader2 } from 'lucide-react';
import { SAVED_QUERY_FOLDER_NAME_MAX_LENGTH } from '../../hooks/useSavedQueryFolders';

interface FolderEditDialogProps {
    mode: 'create' | 'rename';
    initialName?: string;
    parentLabel?: string | null;
    isSubmitting: boolean;
    onSubmit: (name: string) => Promise<void> | void;
    onCancel: () => void;
}

export function FolderEditDialog({
    mode,
    initialName = '',
    parentLabel,
    isSubmitting,
    onSubmit,
    onCancel,
}: FolderEditDialogProps) {
    const [name, setName] = useState(initialName);
    const [error, setError] = useState<string | null>(null);

    const trimmed = name.trim();
    const canSubmit = trimmed.length > 0 && trimmed.length <= SAVED_QUERY_FOLDER_NAME_MAX_LENGTH && !isSubmitting;

    const handleSubmit = async (event: React.FormEvent) => {
        event.preventDefault();
        if (!canSubmit) {
            setError('Enter a name between 1 and 200 characters.');
            return;
        }
        setError(null);
        await onSubmit(trimmed);
    };

    return (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 px-4">
            <form
                onSubmit={handleSubmit}
                className="w-full max-w-sm rounded-md border border-outline-variant bg-white p-5 shadow-xl"
            >
                <h2 className="text-base font-semibold text-on-surface">
                    {mode === 'create' ? 'New folder' : 'Rename folder'}
                </h2>
                {parentLabel && mode === 'create' && (
                    <p className="mt-1 text-xs text-slate-500">Will be created under <strong>{parentLabel}</strong>.</p>
                )}
                <label className="mt-4 block text-xs font-medium text-on-surface">
                    Name
                    <input
                        autoFocus
                        type="text"
                        value={name}
                        onChange={(event) => setName(event.target.value)}
                        maxLength={SAVED_QUERY_FOLDER_NAME_MAX_LENGTH}
                        className="mt-1 w-full rounded border border-outline-variant bg-white px-3 py-2 text-sm text-on-surface focus:border-oxblood focus:outline-none focus:ring-1 focus:ring-oxblood"
                    />
                </label>
                {error && <p className="mt-2 text-xs text-red-600">{error}</p>}
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
                        disabled={!canSubmit}
                        className="inline-flex items-center gap-1.5 rounded bg-oxblood px-3 py-1.5 text-xs font-medium text-white hover:bg-oxblood-soft disabled:cursor-not-allowed disabled:opacity-50"
                    >
                        {isSubmitting && <Loader2 size={12} className="animate-spin" />}
                        {mode === 'create' ? 'Create' : 'Save'}
                    </button>
                </div>
            </form>
        </div>
    );
}
