import { Download, Filter, Loader2 } from 'lucide-react';
import type { RunResponse } from './types';

interface ResultSectionProps {
    queryResult: RunResponse | null;
    isRunning: boolean;
    isDryRun: boolean;
}

function formatCellValue(value: unknown) {
    if (value === null || value === undefined) {
        return '';
    }
    if (typeof value === 'object') {
        try {
            return JSON.stringify(value);
        } catch {
            return String(value);
        }
    }
    return String(value);
}

export function ResultSection({ queryResult, isRunning, isDryRun }: ResultSectionProps) {
    return (
        <div className="flex min-h-[220px] flex-[0.55] flex-col overflow-hidden border-t border-outline-variant bg-white">
            <div className="flex h-10 shrink-0 items-center justify-between border-b border-outline-variant bg-surface-container-low px-4">
                <div className="flex items-center gap-3">
                    <span className="text-[10px] font-bold uppercase tracking-tight text-on-surface">Query Results</span>
                    {queryResult && !queryResult.preview && (
                        <span className="rounded border border-outline-variant bg-white px-2 py-0.5 text-[10px] font-medium text-slate-500">
                            {queryResult.row_count.toLocaleString()} Rows
                        </span>
                    )}
                </div>
                <div className="flex items-center gap-1">
                    <button
                        type="button"
                        className="rounded p-1 text-slate-500 hover:bg-surface-container-high disabled:opacity-40"
                        disabled={!queryResult || queryResult.preview}
                        title="Download"
                        aria-label="Download"
                    >
                        <Download size={16} />
                    </button>
                    <button
                        type="button"
                        className="rounded p-1 text-slate-500 hover:bg-surface-container-high disabled:opacity-40"
                        disabled={!queryResult || queryResult.preview}
                        title="Filter"
                        aria-label="Filter"
                    >
                        <Filter size={16} />
                    </button>
                </div>
            </div>

            <div className="flex-1 overflow-auto">
                {queryResult?.preview && !isRunning && (
                    <div className="m-6 rounded border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900">
                        Preview only. SQL was generated from your saved schema context, but it was not executed against the source database.
                    </div>
                )}

                {!queryResult && !isRunning && (
                    <div className="flex h-full flex-col items-center justify-center p-8 text-slate-400">
                        <p>No results yet. {isDryRun ? 'Preview SQL to inspect the generated response.' : 'Run a query to see results.'}</p>
                    </div>
                )}

                {isRunning && (
                    <div className="flex h-full items-center justify-center text-slate-400">
                        <Loader2 className="mr-2 animate-spin" size={20} />
                        {isDryRun ? 'Generating preview…' : 'Executing query…'}
                    </div>
                )}

                {queryResult && !queryResult.preview && (
                    <table className="w-full border-collapse text-left">
                        <thead className="sticky top-0 z-10 border-b border-outline-variant bg-surface-container-low text-slate-500">
                            <tr className="text-[11px] uppercase tracking-wider">
                                <th className="border-r border-outline-variant/40 bg-surface-container px-4 py-2 font-bold">#</th>
                                {queryResult.columns.map((column) => (
                                    <th
                                        key={column}
                                        className="border-r border-outline-variant/40 px-4 py-2 font-bold"
                                    >
                                        {column}
                                    </th>
                                ))}
                            </tr>
                        </thead>
                        <tbody className="text-[12px] font-medium text-on-surface">
                            {queryResult.rows.map((row, rowIndex) => (
                                <tr
                                    key={`${queryResult.attempt_id}-${rowIndex}`}
                                    className="border-b border-outline-variant/40 transition-colors hover:bg-surface-container-low"
                                >
                                    <td className="border-r border-outline-variant/40 bg-surface-container-low px-4 py-2 text-xs text-slate-400">
                                        {rowIndex + 1}
                                    </td>
                                    {queryResult.columns.map((column) => (
                                        <td
                                            key={`${column}-${rowIndex}`}
                                            className="border-r border-outline-variant/40 px-4 py-2 font-mono text-xs"
                                        >
                                            {formatCellValue(row[column])}
                                        </td>
                                    ))}
                                </tr>
                            ))}
                        </tbody>
                    </table>
                )}
            </div>
        </div>
    );
}
