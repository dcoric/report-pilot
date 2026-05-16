import { useCallback, useEffect, useMemo, useState } from 'react';
import { BookmarkPlus, Eye, EyeOff, Pencil, Plus, RefreshCw, Trash2, Users } from 'lucide-react';
import { format } from 'date-fns';
import { toast } from 'sonner';
import { client } from '../lib/api/client';
import type { components } from '../lib/api/types';

type PromptPreset = components['schemas']['PromptPreset'];

type DataSource = { id: string; name: string };

type EditingState = {
    id?: string;
    title: string;
    prompt_text: string;
    data_source_id: string;
    tags: string;
    visibility: 'private' | 'shared';
};

const EMPTY_FORM: EditingState = {
    title: '',
    prompt_text: '',
    data_source_id: '',
    tags: '',
    visibility: 'private',
};

function presetToForm(preset: PromptPreset): EditingState {
    return {
        id: preset.id,
        title: preset.title,
        prompt_text: preset.prompt_text,
        data_source_id: preset.data_source_id ?? '',
        tags: (preset.tags ?? []).join(', '),
        visibility: preset.visibility,
    };
}

export function PromptPresets() {
    const [items, setItems] = useState<PromptPreset[]>([]);
    const [dataSources, setDataSources] = useState<DataSource[]>([]);
    const [isLoading, setIsLoading] = useState(true);
    const [editing, setEditing] = useState<EditingState | null>(null);
    const [meUserId, setMeUserId] = useState<string | null>(null);

    const fetchAll = useCallback(async () => {
        setIsLoading(true);
        try {
            const [presets, dss, me] = await Promise.all([
                client.GET('/v1/users/me/prompt-presets'),
                client.GET('/v1/data-sources'),
                client.GET('/v1/auth/me'),
            ]);
            setItems(presets.data?.items ?? []);
            setDataSources((dss.data?.items ?? []).map((d) => ({ id: d.id, name: d.name })));
            setMeUserId(me.data?.user?.id ?? null);
        } finally {
            setIsLoading(false);
        }
    }, []);

    useEffect(() => {
        void fetchAll();
    }, [fetchAll]);

    const ownedItems = useMemo(
        () => items.filter((p) => p.owner_user_id === meUserId),
        [items, meUserId],
    );
    const sharedItems = useMemo(
        () => items.filter((p) => p.owner_user_id !== meUserId),
        [items, meUserId],
    );

    function startNew() { setEditing({ ...EMPTY_FORM }); }
    function startEdit(preset: PromptPreset) { setEditing(presetToForm(preset)); }
    function cancel() { setEditing(null); }

    function setField<K extends keyof EditingState>(key: K, value: EditingState[K]) {
        setEditing((prev) => (prev ? { ...prev, [key]: value } : prev));
    }

    async function handleSave() {
        if (!editing) return;
        const tags = editing.tags
            .split(',')
            .map((t) => t.trim())
            .filter(Boolean);
        const body = {
            title: editing.title.trim(),
            prompt_text: editing.prompt_text.trim(),
            data_source_id: editing.data_source_id || null,
            tags,
            visibility: editing.visibility,
        };
        if (editing.id) {
            const { response, error } = await client.PUT('/v1/users/me/prompt-presets/{id}', {
                params: { path: { id: editing.id } },
                body,
            });
            if (!response.ok) {
                const msg = (error && typeof error === 'object' && 'message' in error && typeof (error as { message?: string }).message === 'string')
                    ? (error as { message: string }).message
                    : `Failed (${response.status}).`;
                toast.error(msg);
                return;
            }
            toast.success('Preset updated.');
        } else {
            const { response, error } = await client.POST('/v1/users/me/prompt-presets', { body });
            if (!response.ok) {
                const msg = (error && typeof error === 'object' && 'message' in error && typeof (error as { message?: string }).message === 'string')
                    ? (error as { message: string }).message
                    : `Failed (${response.status}).`;
                toast.error(msg);
                return;
            }
            toast.success('Preset created.');
        }
        setEditing(null);
        await fetchAll();
    }

    async function handleDelete(id: string) {
        const { response } = await client.DELETE('/v1/users/me/prompt-presets/{id}', {
            params: { path: { id } },
        });
        if (response.ok) {
            toast.success('Preset deleted.');
            await fetchAll();
        } else {
            toast.error('Failed to delete preset.');
        }
    }

    function dataSourceName(id?: string | null) {
        if (!id) return null;
        return dataSources.find((d) => d.id === id)?.name ?? id;
    }

    return (
        <div className="flex h-full flex-col p-6">
            <div className="mb-6 flex items-start justify-between">
                <div>
                    <h1 className="text-2xl font-bold text-gray-900">Prompt Presets</h1>
                    <p className="mt-1 text-sm text-gray-500">
                        Save reusable prompts and share favorites with your team.
                    </p>
                </div>
                <button
                    type="button"
                    onClick={startNew}
                    className="flex items-center gap-2 rounded-md bg-oxblood px-4 py-2 text-sm font-medium text-white hover:bg-oxblood-deep"
                >
                    <Plus size={16} />
                    New preset
                </button>
            </div>

            {editing && (
                <div className="mb-6 rounded-lg border border-gray-200 bg-white p-4 shadow-sm">
                    <div className="mb-4 flex items-center justify-between">
                        <h2 className="text-sm font-semibold text-gray-900">
                            {editing.id ? 'Edit preset' : 'New preset'}
                        </h2>
                        <button
                            type="button"
                            onClick={cancel}
                            className="text-xs text-gray-500 hover:text-gray-700"
                        >
                            Cancel
                        </button>
                    </div>
                    <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
                        <div className="md:col-span-2">
                            <label className="mb-1 block text-xs font-medium text-gray-700">Title</label>
                            <input
                                type="text"
                                value={editing.title}
                                onChange={(e) => setField('title', e.target.value)}
                                placeholder="Revenue by region — YoY"
                                className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-oxblood"
                            />
                        </div>
                        <div className="md:col-span-2">
                            <label className="mb-1 block text-xs font-medium text-gray-700">Prompt text</label>
                            <textarea
                                value={editing.prompt_text}
                                onChange={(e) => setField('prompt_text', e.target.value)}
                                rows={4}
                                placeholder="Show me top 10 regions by revenue YoY for the last 12 months."
                                className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-oxblood"
                            />
                        </div>
                        <div>
                            <label className="mb-1 block text-xs font-medium text-gray-700">Data source (optional)</label>
                            <select
                                value={editing.data_source_id}
                                onChange={(e) => setField('data_source_id', e.target.value)}
                                className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-oxblood"
                            >
                                <option value="">Any data source</option>
                                {dataSources.map((ds) => (
                                    <option key={ds.id} value={ds.id}>{ds.name}</option>
                                ))}
                            </select>
                        </div>
                        <div>
                            <label className="mb-1 block text-xs font-medium text-gray-700">Visibility</label>
                            <select
                                value={editing.visibility}
                                onChange={(e) => setField('visibility', e.target.value as 'private' | 'shared')}
                                className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-oxblood"
                            >
                                <option value="private">Private — only you</option>
                                <option value="shared">Shared — visible to all signed-in users</option>
                            </select>
                        </div>
                        <div className="md:col-span-2">
                            <label className="mb-1 block text-xs font-medium text-gray-700">Tags (comma-separated)</label>
                            <input
                                type="text"
                                value={editing.tags}
                                onChange={(e) => setField('tags', e.target.value)}
                                placeholder="finance, revenue"
                                className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-oxblood"
                            />
                        </div>
                    </div>
                    <div className="mt-4 flex justify-end gap-2">
                        <button
                            type="button"
                            onClick={cancel}
                            className="rounded-md border border-gray-300 px-3 py-2 text-sm text-gray-700 hover:bg-gray-100"
                        >
                            Cancel
                        </button>
                        <button
                            type="button"
                            onClick={() => void handleSave()}
                            className="rounded-md bg-oxblood px-3 py-2 text-sm font-medium text-white hover:bg-oxblood-deep"
                        >
                            {editing.id ? 'Save changes' : 'Create preset'}
                        </button>
                    </div>
                </div>
            )}

            <div className="flex-1 space-y-6 overflow-y-auto">
                <PresetSection
                    label="Your presets"
                    icon={<BookmarkPlus size={16} />}
                    items={ownedItems}
                    isLoading={isLoading}
                    canEdit
                    dataSourceName={dataSourceName}
                    onEdit={startEdit}
                    onDelete={handleDelete}
                    emptyHint="You haven't saved any prompts yet. Click 'New preset' to start."
                />
                <PresetSection
                    label="Shared by your team"
                    icon={<Users size={16} />}
                    items={sharedItems}
                    isLoading={isLoading}
                    canEdit={false}
                    dataSourceName={dataSourceName}
                    onEdit={startEdit}
                    onDelete={handleDelete}
                    emptyHint="No shared presets yet. Set a preset's visibility to 'shared' to share it."
                />
            </div>
        </div>
    );
}

function PresetSection({
    label,
    icon,
    items,
    isLoading,
    canEdit,
    dataSourceName,
    onEdit,
    onDelete,
    emptyHint,
}: {
    label: string;
    icon: React.ReactNode;
    items: PromptPreset[];
    isLoading: boolean;
    canEdit: boolean;
    dataSourceName: (id?: string | null) => string | null;
    onEdit: (p: PromptPreset) => void;
    onDelete: (id: string) => void;
    emptyHint: string;
}) {
    return (
        <section>
            <div className="mb-2 flex items-center gap-2 text-sm font-semibold text-gray-800">
                {icon}
                {label}
                <span className="text-xs font-normal text-gray-500">({items.length})</span>
            </div>
            <div className="overflow-hidden rounded-lg border border-gray-200 bg-white shadow-sm">
                {isLoading ? (
                    <div className="flex items-center justify-center py-10 text-sm text-gray-500">
                        <RefreshCw className="mr-2 animate-spin" size={16} /> Loading…
                    </div>
                ) : items.length === 0 ? (
                    <div className="p-6 text-sm text-gray-500">{emptyHint}</div>
                ) : (
                    items.map((preset) => (
                        <div key={preset.id} className="border-b border-gray-100 px-4 py-3 last:border-b-0">
                            <div className="flex items-start justify-between gap-3">
                                <div className="min-w-0 flex-1">
                                    <div className="flex items-center gap-2">
                                        <span className="text-sm font-medium text-gray-900">{preset.title}</span>
                                        <span className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-medium ${
                                            preset.visibility === 'shared' ? 'bg-blue-50 text-blue-700' : 'bg-gray-100 text-gray-600'
                                        }`}>
                                            {preset.visibility === 'shared' ? <Eye size={10} /> : <EyeOff size={10} />}
                                            {preset.visibility}
                                        </span>
                                        {dataSourceName(preset.data_source_id) && (
                                            <span className="rounded-full bg-purple-50 px-2 py-0.5 text-[10px] font-medium text-purple-700">
                                                {dataSourceName(preset.data_source_id)}
                                            </span>
                                        )}
                                    </div>
                                    <p className="mt-1 line-clamp-2 text-xs text-gray-600">{preset.prompt_text}</p>
                                    <div className="mt-1 flex items-center gap-2 text-[10px] text-gray-400">
                                        <span>Updated {format(new Date(preset.updated_at), 'yyyy-MM-dd HH:mm')}</span>
                                        {preset.tags && preset.tags.length > 0 && (
                                            <span>· {preset.tags.join(', ')}</span>
                                        )}
                                    </div>
                                </div>
                                {canEdit && (
                                    <div className="flex shrink-0 items-center gap-2">
                                        <button
                                            type="button"
                                            onClick={() => onEdit(preset)}
                                            className="rounded p-1.5 text-gray-500 hover:bg-gray-100 hover:text-gray-700"
                                            aria-label="Edit preset"
                                        >
                                            <Pencil size={14} />
                                        </button>
                                        <button
                                            type="button"
                                            onClick={() => onDelete(preset.id)}
                                            className="rounded p-1.5 text-gray-500 hover:bg-gray-100 hover:text-red-600"
                                            aria-label="Delete preset"
                                        >
                                            <Trash2 size={14} />
                                        </button>
                                    </div>
                                )}
                            </div>
                        </div>
                    ))
                )}
            </div>
        </section>
    );
}
