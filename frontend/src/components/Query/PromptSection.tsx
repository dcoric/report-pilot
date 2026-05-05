import { useState, type RefObject } from 'react';
import { History, Loader2, Settings2, Sparkles } from 'lucide-react';
import { PromptHistoryPanel } from './PromptHistoryPanel';
import { RunSettingsPopover } from './RunSettingsPopover';
import type { LlmProvider, PromptHistoryItem, PromptHistoryPosition } from './types';

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
