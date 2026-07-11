import { CircleHelp, Loader2, X } from 'lucide-react';
import type { QueryClarification } from './types';

interface ClarificationPanelProps {
    clarification: QueryClarification;
    resolvingOptionId: string | null;
    selectedOptionId: string | null;
    isCancelling: boolean;
    onSelect: (optionId: string) => void;
    onCancel: () => void;
}

export function ClarificationPanel({
    clarification,
    resolvingOptionId,
    selectedOptionId,
    isCancelling,
    onSelect,
    onCancel,
}: ClarificationPanelProps) {
    const busy = Boolean(resolvingOptionId) || isCancelling;

    return (
        <section
            aria-labelledby="query-clarification-title"
            aria-live="polite"
            className="mx-4 mt-4 rounded-lg border border-amber-300 bg-amber-50/70 p-4 shadow-sm"
        >
            <div className="flex items-start justify-between gap-4">
                <div className="flex gap-3">
                    <span className="mt-0.5 rounded-full bg-amber-100 p-2 text-amber-700">
                        <CircleHelp size={18} aria-hidden="true" />
                    </span>
                    <div>
                        <h2 id="query-clarification-title" className="text-sm font-bold text-slate-900">
                            Clarify query intent
                        </h2>
                        <p className="mt-1 text-xs leading-5 text-slate-600">{clarification.message}</p>
                    </div>
                </div>
                <button
                    type="button"
                    onClick={onCancel}
                    disabled={busy}
                    className="flex items-center gap-1 rounded px-2 py-1 text-xs font-medium text-slate-500 hover:bg-amber-100 hover:text-slate-800 disabled:cursor-not-allowed disabled:opacity-50"
                >
                    {isCancelling ? <Loader2 size={12} className="animate-spin" /> : <X size={12} />}
                    Cancel
                </button>
            </div>

            <fieldset className="mt-3 grid gap-2">
                <legend className="sr-only">Query interpretations</legend>
                {clarification.options.map((option) => {
                    const isResolving = resolvingOptionId === option.id;
                    const isSelected = selectedOptionId === option.id;
                    return (
                        <button
                            key={option.id}
                            type="button"
                            onClick={() => onSelect(option.id)}
                            disabled={busy || Boolean(selectedOptionId && !isSelected)}
                            className="group flex w-full items-start justify-between gap-4 rounded-md border border-amber-200 bg-white px-3 py-3 text-left transition-colors hover:border-amber-400 hover:bg-amber-50 disabled:cursor-not-allowed disabled:opacity-60"
                        >
                            <span>
                                <span className="block text-xs font-bold text-slate-800">{option.label}</span>
                                <span className="mt-1 block text-xs leading-5 text-slate-500">{option.description}</span>
                                <span className="mt-1.5 block text-[11px] text-slate-400">
                                    {option.table_refs.join(' · ')}
                                </span>
                            </span>
                            <span className="mt-0.5 shrink-0 text-xs font-semibold text-oxblood">
                                {isResolving
                                    ? <Loader2 size={14} className="animate-spin" />
                                    : isSelected ? 'Retry' : 'Use path'}
                            </span>
                        </button>
                    );
                })}
            </fieldset>
        </section>
    );
}
