import Editor, { type OnMount } from '@monaco-editor/react';
import { ChevronDown, ChevronRight, Copy, Eye, GripHorizontal, Loader2, Play, RotateCcw } from 'lucide-react';
import type { PointerEvent as ReactPointerEvent } from 'react';

interface SqlSectionProps {
    isExpanded: boolean;
    height: number;
    generatedSql: string;
    isGenerating: boolean;
    isRunning: boolean;
    isDryRun: boolean;
    canRun: boolean;
    onToggle: () => void;
    onCopy: () => void;
    onReset: () => void;
    onFormat: () => void;
    onRun: () => void;
    onSqlChange: (value: string) => void;
    onEditorMount: OnMount;
    onResizeStart: (event: ReactPointerEvent<HTMLDivElement>) => void;
}

export function SqlSection({
    isExpanded,
    height,
    generatedSql,
    isGenerating,
    isRunning,
    isDryRun,
    canRun,
    onToggle,
    onCopy,
    onReset,
    onFormat,
    onRun,
    onSqlChange,
    onEditorMount,
    onResizeStart,
}: SqlSectionProps) {
    return (
        <>
            <div className="flex-shrink-0 border-b border-gray-200 bg-white">
                <div className="flex items-center justify-between border-b border-gray-200 bg-gray-50 px-4 py-2">
                    <button
                        type="button"
                        onClick={onToggle}
                        aria-expanded={isExpanded}
                        aria-controls="query-sql-section"
                        className="flex items-center gap-1.5 text-xs font-semibold text-gray-700"
                    >
                        {isExpanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                        <span>SQL section</span>
                    </button>

                    <div className="flex items-center gap-2">
                        <button
                            onClick={onCopy}
                            className="rounded border border-gray-300 bg-white px-2 py-1 text-xs font-medium text-gray-700 hover:bg-gray-50"
                            disabled={!generatedSql}
                            title="Copy SQL"
                        >
                            <Copy size={14} />
                        </button>
                        <button
                            onClick={onReset}
                            className="rounded border border-gray-300 bg-white px-2 py-1 text-xs font-medium text-gray-700 hover:bg-gray-50"
                            disabled={!generatedSql}
                            title="Reset to original"
                        >
                            <RotateCcw size={14} />
                        </button>
                        <button
                            type="button"
                            className="rounded border border-gray-300 bg-white px-2 py-1 text-xs font-medium text-gray-700 hover:bg-gray-50"
                            aria-label="Preview SQL section"
                        >
                            <Eye size={14} />
                        </button>
                        <button
                            onClick={onFormat}
                            className="px-2 py-1 text-xs font-medium text-gray-600 hover:text-gray-800 disabled:cursor-not-allowed disabled:opacity-50"
                            disabled={!generatedSql}
                        >
                            Format SQL
                        </button>
                        <button
                            onClick={onRun}
                            disabled={isRunning || !generatedSql || !canRun}
                            className="flex items-center gap-1.5 rounded bg-blue-600 px-4 py-1.5 text-xs font-medium text-white hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-50"
                        >
                            {isRunning ? <Loader2 size={14} className="animate-spin" /> : <Play size={14} />}
                            {isDryRun ? 'Preview SQL' : 'Run'}
                        </button>
                    </div>
                </div>

                {isExpanded && (
                    <div id="query-sql-section" className="overflow-hidden bg-gray-50" style={{ height }}>
                        {isGenerating ? (
                            <div className="flex h-full min-h-20 items-center justify-center text-sm text-gray-400">
                                <Loader2 className="mr-2 animate-spin" size={16} />
                                Generating SQL...
                            </div>
                        ) : generatedSql ? (
                            <div className="flex h-full flex-col">
                                <div className="border-b border-gray-200 bg-gray-100 px-4 py-1 text-xs text-gray-500">
                                    Generated SQL
                                </div>
                                <div className="min-h-0 flex-1">
                                    <Editor
                                        height="100%"
                                        language="sql"
                                        value={generatedSql}
                                        onChange={(value) => onSqlChange(value ?? '')}
                                        onMount={onEditorMount}
                                        options={{
                                            automaticLayout: true,
                                            fontSize: 12,
                                            lineNumbersMinChars: 3,
                                            minimap: { enabled: false },
                                            scrollBeyondLastLine: false,
                                            tabSize: 2,
                                            wordWrap: 'on',
                                        }}
                                    />
                                </div>
                            </div>
                        ) : (
                            <div className="flex h-full min-h-20 items-center justify-center p-4 text-center text-sm text-gray-400">
                                Enter a question and press Enter or click Ask to generate SQL
                            </div>
                        )}
                    </div>
                )}
            </div>

            {isExpanded && (
                <div
                    role="separator"
                    aria-orientation="horizontal"
                    aria-label="Resize SQL section"
                    onPointerDown={onResizeStart}
                    className="flex h-2 flex-shrink-0 touch-none items-center justify-center bg-gray-100 hover:bg-gray-200 active:bg-gray-300 cursor-row-resize"
                >
                    <GripHorizontal size={14} className="text-gray-400" />
                </div>
            )}
        </>
    );
}
