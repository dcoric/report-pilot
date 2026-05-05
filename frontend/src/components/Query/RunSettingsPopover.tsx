import type { ReactNode } from 'react';
import type { LlmProvider } from './types';

const PROVIDER_DISPLAY_NAMES: Record<string, string> = {
    openai: 'OpenAI',
    gemini: 'Google Gemini',
    deepseek: 'DeepSeek',
    openrouter: 'OpenRouter',
};

interface RunSettingsPopoverProps {
    isOpen: boolean;
    onToggle: () => void;
    onClose: () => void;
    isDryRun: boolean;
    provider: string;
    model: string;
    maxRows: number;
    timeout: number;
    llmProviders: LlmProvider[];
    onDryRunChange: (value: boolean) => void;
    onProviderChange: (value: string) => void;
    onModelChange: (value: string) => void;
    onMaxRowsChange: (value: number) => void;
    onTimeoutChange: (value: number) => void;
    trigger: ReactNode;
}

export function RunSettingsPopover({
    isOpen,
    onClose,
    isDryRun,
    provider,
    model,
    maxRows,
    timeout,
    llmProviders,
    onDryRunChange,
    onProviderChange,
    onModelChange,
    onMaxRowsChange,
    onTimeoutChange,
    trigger,
}: RunSettingsPopoverProps) {
    return (
        <div className="relative">
            {trigger}
            {isOpen && (
                <>
                    <div className="fixed inset-0 z-30" onClick={onClose} />
                    <div className="absolute right-0 top-full z-40 mt-2 w-72 rounded-md border border-outline-variant bg-white p-3 shadow-lg">
                        <p className="mb-3 text-[10px] font-bold uppercase tracking-wider text-slate-500">Run Settings</p>

                        <label className="mb-3 flex items-center justify-between gap-2 text-xs text-slate-700">
                            <span>Dry run (no execute)</span>
                            <input
                                type="checkbox"
                                checked={isDryRun}
                                onChange={(event) => onDryRunChange(event.target.checked)}
                                className="h-4 w-4 rounded border-outline-variant text-oxblood focus:ring-oxblood"
                            />
                        </label>

                        <div className="mb-3">
                            <label className="mb-1 block text-[11px] font-medium text-slate-600">Provider</label>
                            <select
                                value={provider}
                                onChange={(event) => {
                                    const next = event.target.value;
                                    onProviderChange(next);
                                    const config = llmProviders.find((entry) => entry.provider === next);
                                    if (config) {
                                        onModelChange(config.default_model);
                                    }
                                }}
                                className="w-full rounded border border-outline-variant px-2 py-1 text-xs focus:border-oxblood focus:outline-none focus:ring-1 focus:ring-oxblood"
                            >
                                {llmProviders.length === 0 && <option value="">No providers configured</option>}
                                {llmProviders.map((entry) => (
                                    <option key={entry.provider} value={entry.provider}>
                                        {entry.display_name || PROVIDER_DISPLAY_NAMES[entry.provider] || entry.provider}
                                    </option>
                                ))}
                            </select>
                        </div>

                        <div className="mb-3">
                            <label className="mb-1 block text-[11px] font-medium text-slate-600">Model</label>
                            <input
                                type="text"
                                value={model}
                                onChange={(event) => onModelChange(event.target.value)}
                                placeholder="e.g. gpt-5.2"
                                className="w-full rounded border border-outline-variant px-2 py-1 text-xs focus:border-oxblood focus:outline-none focus:ring-1 focus:ring-oxblood"
                            />
                        </div>

                        <div className="grid grid-cols-2 gap-2">
                            <div>
                                <label className="mb-1 block text-[11px] font-medium text-slate-600">Max Rows</label>
                                <input
                                    type="number"
                                    value={maxRows}
                                    min={1}
                                    onChange={(event) => onMaxRowsChange(Number(event.target.value))}
                                    className="w-full rounded border border-outline-variant px-2 py-1 text-xs focus:border-oxblood focus:outline-none focus:ring-1 focus:ring-oxblood"
                                />
                            </div>
                            <div>
                                <label className="mb-1 block text-[11px] font-medium text-slate-600">Timeout (s)</label>
                                <input
                                    type="number"
                                    value={timeout}
                                    min={1}
                                    onChange={(event) => onTimeoutChange(Number(event.target.value))}
                                    className="w-full rounded border border-outline-variant px-2 py-1 text-xs focus:border-oxblood focus:outline-none focus:ring-1 focus:ring-oxblood"
                                />
                            </div>
                        </div>
                    </div>
                </>
            )}
        </div>
    );
}
