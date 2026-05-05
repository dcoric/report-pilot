import { useState, type FormEvent, type KeyboardEvent } from 'react';
import { X } from 'lucide-react';
import type { SavedQuery } from './types';

const SAVED_QUERY_NAME_MAX_LENGTH = 200;
const SAVED_QUERY_DESCRIPTION_MAX_LENGTH = 1000;
const SAVED_QUERY_TAG_MAX_LENGTH = 40;
const SAVED_QUERY_MAX_TAGS = 20;

export interface SaveQueryDialogValues {
    name: string;
    description: string;
    tags: string[];
}

interface SaveQueryDialogProps {
    isOpen: boolean;
    mode: 'create' | 'edit';
    initial?: Pick<SavedQuery, 'name' | 'description' | 'tags'> | null;
    isSubmitting: boolean;
    onClose: () => void;
    onSave: (values: SaveQueryDialogValues) => void;
    headerHint?: string;
}

function normalizeTagInput(raw: string) {
    return raw.trim().toLowerCase().replace(/^#/, '').slice(0, SAVED_QUERY_TAG_MAX_LENGTH);
}

export function SaveQueryDialog({
    isOpen,
    mode,
    initial,
    isSubmitting,
    onClose,
    onSave,
    headerHint,
}: SaveQueryDialogProps) {
    const [name, setName] = useState(() => initial?.name ?? '');
    const [description, setDescription] = useState(() => initial?.description ?? '');
    const [tags, setTags] = useState<string[]>(() => initial?.tags ?? []);
    const [tagDraft, setTagDraft] = useState('');

    if (!isOpen) {
        return null;
    }

    const commitTagDraft = () => {
        const next = normalizeTagInput(tagDraft);
        if (!next) {
            setTagDraft('');
            return;
        }
        if (tags.includes(next)) {
            setTagDraft('');
            return;
        }
        if (tags.length >= SAVED_QUERY_MAX_TAGS) {
            return;
        }
        setTags((current) => [...current, next]);
        setTagDraft('');
    };

    const handleTagKey = (event: KeyboardEvent<HTMLInputElement>) => {
        if (event.key === 'Enter' || event.key === ',' || event.key === 'Tab') {
            if (tagDraft.trim()) {
                event.preventDefault();
                commitTagDraft();
            }
        } else if (event.key === 'Backspace' && !tagDraft && tags.length > 0) {
            setTags((current) => current.slice(0, -1));
        }
    };

    const removeTag = (tag: string) => {
        setTags((current) => current.filter((existing) => existing !== tag));
    };

    const handleSubmit = (event: FormEvent) => {
        event.preventDefault();
        const finalTags = tagDraft.trim() ? [...tags, normalizeTagInput(tagDraft)] : tags;
        const dedupedTags = Array.from(new Set(finalTags.filter(Boolean)));
        onSave({
            name: name.trim(),
            description: description.trim(),
            tags: dedupedTags,
        });
    };

    return (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
            <div className="w-full max-w-md overflow-hidden rounded-lg bg-white shadow-xl">
                <div className="flex items-center justify-between border-b border-outline-variant px-4 py-3">
                    <div>
                        <h2 className="text-lg font-semibold text-on-surface">
                            {mode === 'edit' ? 'Edit Saved Query' : 'Save Query'}
                        </h2>
                        {headerHint && (
                            <p className="text-xs text-slate-500">{headerHint}</p>
                        )}
                    </div>
                    <button
                        type="button"
                        onClick={onClose}
                        className="text-slate-500 hover:text-slate-800"
                        aria-label="Close save query dialog"
                    >
                        <X size={18} />
                    </button>
                </div>

                <form onSubmit={handleSubmit} className="space-y-4 p-4">
                    <div>
                        <label className="mb-1 block text-sm font-medium text-slate-700">Name</label>
                        <input
                            type="text"
                            required
                            maxLength={SAVED_QUERY_NAME_MAX_LENGTH}
                            value={name}
                            onChange={(event) => setName(event.target.value)}
                            className="w-full rounded-md border border-outline-variant px-3 py-2 text-sm focus:border-oxblood focus:outline-none focus:ring-2 focus:ring-oxblood/30"
                        />
                    </div>

                    <div>
                        <label className="mb-1 block text-sm font-medium text-slate-700">Description</label>
                        <textarea
                            rows={3}
                            maxLength={SAVED_QUERY_DESCRIPTION_MAX_LENGTH}
                            value={description}
                            onChange={(event) => setDescription(event.target.value)}
                            className="w-full rounded-md border border-outline-variant px-3 py-2 text-sm focus:border-oxblood focus:outline-none focus:ring-2 focus:ring-oxblood/30"
                            placeholder="Optional description"
                        />
                    </div>

                    <div>
                        <label className="mb-1 block text-sm font-medium text-slate-700">
                            Tags
                            <span className="ml-2 text-xs font-normal text-slate-400">
                                {tags.length}/{SAVED_QUERY_MAX_TAGS}
                            </span>
                        </label>
                        <div className="flex flex-wrap items-center gap-1.5 rounded-md border border-outline-variant bg-white px-2 py-1.5 focus-within:border-oxblood focus-within:ring-2 focus-within:ring-oxblood/30">
                            {tags.map((tag) => (
                                <span
                                    key={tag}
                                    className="inline-flex items-center gap-1 rounded border border-outline-variant bg-amber-accent/20 px-1.5 py-0.5 text-[11px] font-medium text-on-secondary-container"
                                >
                                    #{tag}
                                    <button
                                        type="button"
                                        onClick={() => removeTag(tag)}
                                        className="text-slate-500 hover:text-slate-800"
                                        aria-label={`Remove tag ${tag}`}
                                    >
                                        <X size={10} />
                                    </button>
                                </span>
                            ))}
                            <input
                                type="text"
                                value={tagDraft}
                                onChange={(event) => setTagDraft(event.target.value)}
                                onKeyDown={handleTagKey}
                                onBlur={() => tagDraft.trim() && commitTagDraft()}
                                className="min-w-[80px] flex-1 border-0 px-1 text-xs focus:outline-none"
                                placeholder={tags.length === 0 ? 'finance, daily, ops…' : ''}
                                maxLength={SAVED_QUERY_TAG_MAX_LENGTH}
                                disabled={tags.length >= SAVED_QUERY_MAX_TAGS}
                            />
                        </div>
                        <p className="mt-1 text-[11px] text-slate-400">Press Enter or comma to add a tag.</p>
                    </div>

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
                            disabled={isSubmitting || !name.trim()}
                            className="rounded-md bg-oxblood px-4 py-2 text-sm font-medium text-white hover:bg-oxblood-soft disabled:cursor-not-allowed disabled:opacity-50"
                        >
                            {isSubmitting ? 'Saving…' : mode === 'edit' ? 'Save Changes' : 'Save Query'}
                        </button>
                    </div>
                </form>
            </div>
        </div>
    );
}
