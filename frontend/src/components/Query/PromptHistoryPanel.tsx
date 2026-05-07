import { createPortal } from 'react-dom';
import { Loader2 } from 'lucide-react';
import type { RefObject } from 'react';
import type { PromptHistoryItem, PromptHistoryPosition } from './types';

interface PromptHistoryPanelProps {
    isOpen: boolean;
    isLoading: boolean;
    items: PromptHistoryItem[];
    query: string;
    position: PromptHistoryPosition;
    panelRef: RefObject<HTMLDivElement | null>;
    onQueryChange: (value: string) => void;
    onSelectItem: (item: PromptHistoryItem) => void;
}

export function PromptHistoryPanel({
    isOpen,
    isLoading,
    items,
    query,
    position,
    panelRef,
    onQueryChange,
    onSelectItem,
}: PromptHistoryPanelProps) {
    if (!isOpen || typeof document === 'undefined') {
        return null;
    }

    return createPortal(
        <div
            ref={panelRef}
            className="fixed z-[200] flex max-h-full flex-col overflow-hidden rounded-xl border border-gray-200 bg-white shadow-2xl"
            style={{
                top: position.top,
                left: position.left,
                width: position.width,
                maxHeight: position.panelMaxHeight,
            }}
        >
            <div className="border-b border-gray-100 bg-gray-50/60 px-5 pt-4 pb-3">
                <div className="mb-2 text-sm font-semibold text-gray-800">Prompt History</div>
                <input
                    type="text"
                    value={query}
                    onChange={(event) => onQueryChange(event.target.value)}
                    placeholder="Search prompt history..."
                    className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:ring-2 focus:ring-oxblood focus:outline-none"
                />
            </div>

            <div className="min-h-0 flex-1 overflow-auto p-2">
                {isLoading && (
                    <div className="flex items-center justify-center gap-2 px-4 py-10 text-sm text-gray-500">
                        <Loader2 size={14} className="animate-spin" />
                        Loading prompt history...
                    </div>
                )}

                {!isLoading && items.length === 0 && (
                    <div className="px-4 py-10 text-center text-sm text-gray-500">
                        No prompts found.
                    </div>
                )}

                {!isLoading && items.map((item) => (
                    <button
                        key={item.id}
                        type="button"
                        onClick={() => onSelectItem(item)}
                        className="mb-1 w-full rounded-lg border border-transparent px-4 py-3.5 text-left transition-colors last:mb-0 hover:border-gray-200 hover:bg-gray-50"
                        title={item.question}
                    >
                        <div className="line-clamp-2 break-words text-sm leading-5 font-medium text-gray-800">{item.question}</div>
                        <div className="mt-2 flex items-center justify-between gap-2 text-xs text-gray-500">
                            <span>{new Date(item.created_at).toLocaleString()}</span>
                            <span className={`font-medium ${item.latest_sql ? 'text-emerald-700' : 'text-gray-400'}`}>
                                {item.latest_sql ? 'SQL cached' : 'No SQL'}
                            </span>
                        </div>
                    </button>
                ))}
            </div>
        </div>,
        document.body,
    );
}
