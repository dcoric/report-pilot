import { useCallback, useEffect, useRef, useState, type RefObject } from 'react';
import { Bookmark, History, Loader2, Settings2, Sparkles } from 'lucide-react';
import { PromptHistoryPanel } from './PromptHistoryPanel';
import { RunSettingsPopover } from './RunSettingsPopover';
import type { LlmProvider, PromptHistoryItem, PromptHistoryPosition } from './types';
import { client } from '../../lib/api/client';
import type { components } from '../../lib/api/types';

type PromptPreset = components['schemas']['PromptPreset'];

interface PromptSectionProps {
    isDryRun: boolean;
    question: string;
    llmProviders: LlmProvider[];
    provider: string;
    model: string;
    maxRows: number;
    timeout: number;
    isGenerating: boolean;
    selectedDataSourceId: string;
    isPromptHistoryOpen: boolean;
    isPromptHistoryLoading: boolean;
    promptHistoryQuery: string;
    filteredPromptHistory: PromptHistoryItem[];
    promptHistoryPosition: PromptHistoryPosition;
    promptHistoryRef: RefObject<HTMLDivElement | null>;
    promptHistoryButtonRef: RefObject<HTMLButtonElement | null>;
    promptHistoryPanelRef: RefObject<HTMLDivElement | null>;
    onDryRunChange: (value: boolean) => void;
    onQuestionChange: (value: string) => void;
    onProviderChange: (value: string) => void;
    onModelChange: (value: string) => void;
    onMaxRowsChange: (value: number) => void;
    onTimeoutChange: (value: number) => void;
    onPromptHistoryToggle: () => void;
    onPromptHistoryQueryChange: (value: string) => void;
    onPromptHistorySelect: (item: PromptHistoryItem) => void;
    onAsk: () => void;
}

export function PromptSection({
    isDryRun,
    question,
    llmProviders,
    provider,
    model,
    maxRows,
    timeout,
    isGenerating,
    selectedDataSourceId,
    isPromptHistoryOpen,
    isPromptHistoryLoading,
    promptHistoryQuery,
    filteredPromptHistory,
    promptHistoryPosition,
    promptHistoryRef,
    promptHistoryButtonRef,
    promptHistoryPanelRef,
    onDryRunChange,
    onQuestionChange,
    onProviderChange,
    onModelChange,
    onMaxRowsChange,
    onTimeoutChange,
    onPromptHistoryToggle,
    onPromptHistoryQueryChange,
    onPromptHistorySelect,
    onAsk,
}: PromptSectionProps) {
    const [isSettingsOpen, setIsSettingsOpen] = useState(false);
    const canGenerate = !isGenerating && question.trim().length > 0 && Boolean(selectedDataSourceId);

    // AUTH-007: per-user prompt presets. We lazy-load them the first time the
    // picker opens so the page doesn't issue an extra request on mount.
    const [isPresetsOpen, setIsPresetsOpen] = useState(false);
    const [presets, setPresets] = useState<PromptPreset[] | null>(null);
    const [presetsLoading, setPresetsLoading] = useState(false);
    const presetsPanelRef = useRef<HTMLDivElement | null>(null);
    const loadPresets = useCallback(async () => {
        setPresetsLoading(true);
        try {
            const { data } = await client.GET('/v1/users/me/prompt-presets');
            setPresets(data?.items ?? []);
        } finally {
            setPresetsLoading(false);
        }
    }, []);
    useEffect(() => {
        if (isPresetsOpen && presets === null) void loadPresets();
    }, [isPresetsOpen, presets, loadPresets]);
    useEffect(() => {
        if (!isPresetsOpen) return;
        const onDocClick = (event: MouseEvent) => {
            if (presetsPanelRef.current && !presetsPanelRef.current.contains(event.target as Node)) {
                setIsPresetsOpen(false);
            }
        };
        document.addEventListener('mousedown', onDocClick);
        return () => document.removeEventListener('mousedown', onDocClick);
    }, [isPresetsOpen]);

    return (
        <div className="flex-shrink-0 border-b border-outline-variant bg-surface-container-low p-4">
            {isDryRun && (
                <div className="mb-3 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-900">
                    Dry run skips live database execution. You will get generated SQL, citations, and confidence only.
                </div>
            )}
            <div className="relative flex items-center">
                <Sparkles size={16} className="absolute left-3 text-amber-accent" />
                <input
                    type="text"
                    value={question}
                    onChange={(event) => onQuestionChange(event.target.value)}
                    onKeyDown={(event) => {
                        if (event.key === 'Enter') {
                            event.preventDefault();
                            if (canGenerate) {
                                onAsk();
                            }
                        }
                    }}
                    placeholder="Adjust this query to group by region and include YoY growth…"
                    className="w-full rounded-lg border border-outline-variant bg-white py-2.5 pl-10 pr-44 text-sm placeholder-slate-400 focus:border-oxblood focus:outline-none focus:ring-1 focus:ring-oxblood"
                />

                <div className="absolute right-2 flex items-center gap-1">
                    <div ref={presetsPanelRef} className="relative">
                        <button
                            type="button"
                            onClick={() => setIsPresetsOpen((open) => !open)}
                            className="rounded p-1.5 text-slate-500 hover:bg-slate-100"
                            title="Prompt presets"
                            aria-label="Prompt presets"
                        >
                            <Bookmark size={14} />
                        </button>
                        {isPresetsOpen && (
                            <div className="absolute right-0 top-9 z-30 w-80 overflow-hidden rounded-lg border border-outline-variant bg-white shadow-lg">
                                <div className="flex items-center justify-between border-b border-outline-variant px-3 py-2 text-xs font-medium text-slate-600">
                                    <span>Saved prompts</span>
                                    <span className="text-[10px] text-slate-400">{presets?.length ?? 0}</span>
                                </div>
                                <div className="max-h-80 overflow-y-auto">
                                    {presetsLoading ? (
                                        <div className="px-3 py-4 text-xs text-slate-500">Loading…</div>
                                    ) : !presets || presets.length === 0 ? (
                                        <div className="px-3 py-4 text-xs text-slate-500">
                                            No saved prompts yet. Create one from the <strong>Prompts</strong> page.
                                        </div>
                                    ) : (
                                        presets.map((preset) => {
                                            const matchesDataSource = !preset.data_source_id || preset.data_source_id === selectedDataSourceId;
                                            return (
                                                <button
                                                    key={preset.id}
                                                    type="button"
                                                    onClick={() => { onQuestionChange(preset.prompt_text); setIsPresetsOpen(false); }}
                                                    className="block w-full border-b border-outline-variant px-3 py-2 text-left last:border-b-0 hover:bg-slate-50"
                                                >
                                                    <div className="flex items-center justify-between gap-2">
                                                        <span className="truncate text-xs font-medium text-slate-800">{preset.title}</span>
                                                        <span className={`shrink-0 rounded-full px-1.5 py-0.5 text-[9px] font-medium ${
                                                            preset.visibility === 'shared' ? 'bg-blue-50 text-blue-700' : 'bg-slate-100 text-slate-600'
                                                        }`}>
                                                            {preset.visibility}
                                                        </span>
                                                    </div>
                                                    <div className="mt-0.5 line-clamp-1 text-[11px] text-slate-500">{preset.prompt_text}</div>
                                                    {!matchesDataSource && preset.data_source_id && (
                                                        <div className="mt-0.5 text-[10px] text-amber-700">
                                                            Saved for a different data source
                                                        </div>
                                                    )}
                                                </button>
                                            );
                                        })
                                    )}
                                </div>
                            </div>
                        )}
                    </div>
                    <div ref={promptHistoryRef} className="relative">
                        <button
                            ref={promptHistoryButtonRef}
                            type="button"
                            onClick={onPromptHistoryToggle}
                            className="rounded p-1.5 text-slate-500 hover:bg-slate-100"
                            title="Prompt history"
                            aria-label="Prompt history"
                        >
                            <History size={14} />
                        </button>
                        <PromptHistoryPanel
                            isOpen={isPromptHistoryOpen}
                            isLoading={isPromptHistoryLoading}
                            items={filteredPromptHistory}
                            query={promptHistoryQuery}
                            position={promptHistoryPosition}
                            panelRef={promptHistoryPanelRef}
                            onQueryChange={onPromptHistoryQueryChange}
                            onSelectItem={onPromptHistorySelect}
                        />
                    </div>
                    <RunSettingsPopover
                        isOpen={isSettingsOpen}
                        onToggle={() => setIsSettingsOpen((open) => !open)}
                        onClose={() => setIsSettingsOpen(false)}
                        isDryRun={isDryRun}
                        provider={provider}
                        model={model}
                        maxRows={maxRows}
                        timeout={timeout}
                        llmProviders={llmProviders}
                        onDryRunChange={onDryRunChange}
                        onProviderChange={onProviderChange}
                        onModelChange={onModelChange}
                        onMaxRowsChange={onMaxRowsChange}
                        onTimeoutChange={onTimeoutChange}
                        trigger={(
                            <button
                                type="button"
                                onClick={() => setIsSettingsOpen((open) => !open)}
                                className="rounded p-1.5 text-slate-500 hover:bg-slate-100"
                                title="Run settings"
                                aria-label="Run settings"
                            >
                                <Settings2 size={14} />
                            </button>
                        )}
                    />
                    <button
                        type="button"
                        onClick={onAsk}
                        disabled={!canGenerate}
                        className="flex items-center gap-1 rounded bg-oxblood px-3 py-1.5 text-xs font-medium text-white transition-colors hover:bg-oxblood-soft disabled:cursor-not-allowed disabled:opacity-50"
                    >
                        {isGenerating ? <Loader2 size={12} className="animate-spin" /> : null}
                        {isDryRun ? 'Preview' : 'Generate'}
                    </button>
                </div>
            </div>
        </div>
    );
}
