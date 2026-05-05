import Editor, { type OnMount } from '@monaco-editor/react';
import { Copy, Loader2, RotateCcw, WandSparkles } from 'lucide-react';

interface SqlSectionProps {
    generatedSql: string;
    isGenerating: boolean;
    onCopy: () => void;
    onReset: () => void;
    onFormat: () => void;
    onSqlChange: (value: string) => void;
    onEditorMount: OnMount;
}

export function SqlSection({
    generatedSql,
    isGenerating,
    onCopy,
    onReset,
    onFormat,
    onSqlChange,
    onEditorMount,
}: SqlSectionProps) {
    return (
        <div className="flex flex-[0.45] flex-col overflow-hidden border-b border-outline-variant bg-white">
            <div className="flex h-9 shrink-0 items-center justify-between border-b border-outline-variant bg-surface-container-low px-4">
                <span className="text-[10px] font-semibold uppercase tracking-wider text-slate-500">
                    Generated SQL
                </span>
                <div className="flex items-center gap-1">
                    <button
                        type="button"
                        onClick={onCopy}
                        disabled={!generatedSql}
                        className="rounded p-1 text-slate-500 hover:bg-surface-container-high disabled:cursor-not-allowed disabled:opacity-50"
                        title="Copy SQL"
                        aria-label="Copy SQL"
                    >
                        <Copy size={14} />
                    </button>
                    <button
                        type="button"
                        onClick={onReset}
                        disabled={!generatedSql}
                        className="rounded p-1 text-slate-500 hover:bg-surface-container-high disabled:cursor-not-allowed disabled:opacity-50"
                        title="Reset to original"
                        aria-label="Reset SQL to original"
                    >
                        <RotateCcw size={14} />
                    </button>
                    <button
                        type="button"
                        onClick={onFormat}
                        disabled={!generatedSql}
                        className="flex items-center gap-1 rounded p-1 text-slate-500 hover:bg-surface-container-high disabled:cursor-not-allowed disabled:opacity-50"
                        title="Format SQL"
                        aria-label="Format SQL"
                    >
                        <WandSparkles size={14} />
                    </button>
                </div>
            </div>
            <div className="min-h-0 flex-1 bg-white">
                {isGenerating ? (
                    <div className="flex h-full items-center justify-center text-sm text-slate-400">
                        <Loader2 className="mr-2 animate-spin" size={16} />
                        Generating SQL…
                    </div>
                ) : generatedSql ? (
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
                ) : (
                    <div className="flex h-full items-center justify-center p-4 text-center text-sm text-slate-400">
                        Generate a query or load a saved one to start editing SQL.
                    </div>
                )}
            </div>
        </div>
    );
}
