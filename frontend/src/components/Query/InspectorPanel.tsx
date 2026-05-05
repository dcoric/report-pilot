import { Database, Info, Table } from 'lucide-react';
import type { CitationCollection, RunResponse, SavedQuery } from './types';
import type { components } from '../../lib/api/types';

type DataSource = components['schemas']['DataSourceListResponse']['items'][number];

interface InspectorPanelProps {
    loadedSavedQuery: SavedQuery | null;
    selectedDataSource: DataSource | null;
    queryResult: RunResponse | null;
    isDryRun: boolean;
}

function MetricRow({ label, value }: { label: string; value: string }) {
    return (
        <div className="flex items-center justify-between border-b border-outline-variant/60 py-1.5 last:border-0">
            <span className="text-[11px] text-slate-500">{label}</span>
            <span className="font-mono text-[11px] font-medium text-on-surface">{value}</span>
        </div>
    );
}

function renderDependencies(citations: CitationCollection | undefined) {
    const schemaObjects = citations?.schema_objects ?? [];
    if (schemaObjects.length === 0) {
        return <p className="text-[11px] text-slate-400">No dependencies tracked.</p>;
    }
    return (
        <div className="space-y-1">
            {schemaObjects.map((entry) => (
                <div key={entry.id} className="rounded p-2 transition-all hover:bg-surface-container-low">
                    <div className="mb-0.5 flex items-center gap-2">
                        <Table size={14} className="text-oxblood" />
                        <p className="truncate text-[11px] font-semibold text-on-surface">
                            {entry.schema_name}.{entry.object_name}
                        </p>
                    </div>
                    <p className="line-clamp-1 pl-6 text-[10px] text-slate-500">{entry.object_type}</p>
                </div>
            ))}
        </div>
    );
}

export function InspectorPanel({
    loadedSavedQuery,
    selectedDataSource,
    queryResult,
    isDryRun,
}: InspectorPanelProps) {
    const tags = loadedSavedQuery?.tags ?? [];

    return (
        <aside className="flex w-80 flex-col overflow-y-auto border-l border-outline-variant bg-white p-4">
            <div className="mb-6">
                <h2 className="mb-4 flex items-center justify-between border-b border-outline-variant pb-2 text-[10px] font-bold uppercase tracking-widest text-slate-500">
                    Inspector
                    <Info size={14} />
                </h2>

                <div className="mb-4 rounded border border-outline-variant bg-white p-3">
                    <div className="mb-4 flex items-center justify-between">
                        <span className="text-[10px] font-bold uppercase text-slate-500">Status</span>
                        <span className="rounded border border-emerald-100 bg-emerald-50 px-2 py-0.5 text-[10px] font-bold uppercase text-emerald-600">
                            {loadedSavedQuery ? 'Saved' : 'Draft'}
                        </span>
                    </div>
                    <div className="space-y-3">
                        <div>
                            <p className="mb-1 text-[10px] font-bold uppercase text-slate-500">Data Source</p>
                            <p className="flex items-center gap-1.5 text-[12px] font-semibold text-on-surface">
                                <Database size={14} className="text-oxblood" />
                                {selectedDataSource?.name || 'No data source selected'}
                            </p>
                        </div>
                        <div>
                            <p className="mb-2 text-[10px] font-bold uppercase text-slate-500">Tags</p>
                            {tags.length === 0 ? (
                                <p className="text-[11px] text-slate-400">No tags assigned.</p>
                            ) : (
                                <div className="flex flex-wrap gap-1.5">
                                    {tags.map((tag) => (
                                        <span
                                            key={tag}
                                            className="rounded border border-outline-variant bg-amber-accent/20 px-2 py-0.5 text-[10px] font-medium uppercase text-on-secondary-container"
                                        >
                                            #{tag}
                                        </span>
                                    ))}
                                </div>
                            )}
                        </div>
                    </div>
                </div>
            </div>

            <div className="mb-6">
                <h3 className="mb-3 border-b border-outline-variant px-1 pb-1 text-[10px] font-bold uppercase tracking-widest text-oxblood">
                    Execution
                </h3>
                <div className="rounded border border-outline-variant bg-surface-container-low p-3">
                    {queryResult ? (
                        <div>
                            <MetricRow
                                label="Mode"
                                value={queryResult.preview ? 'Dry run' : 'Executed'}
                            />
                            <MetricRow label="Attempt" value={queryResult.attempt_id.slice(0, 12)} />
                            <MetricRow
                                label="Rows"
                                value={queryResult.preview ? '—' : String(queryResult.row_count)}
                            />
                            <MetricRow
                                label="Duration"
                                value={queryResult.preview ? '—' : `${queryResult.duration_ms} ms`}
                            />
                            <MetricRow
                                label="Confidence"
                                value={queryResult.confidence ? `${(queryResult.confidence * 100).toFixed(1)}%` : 'N/A'}
                            />
                            <MetricRow label="Provider" value={queryResult.provider?.name || 'N/A'} />
                            <MetricRow label="Model" value={queryResult.provider?.model || 'N/A'} />
                        </div>
                    ) : (
                        <p className="text-[11px] text-slate-400">
                            {isDryRun ? 'Preview SQL to see metadata.' : 'Run the query to see metadata.'}
                        </p>
                    )}
                </div>
            </div>

            <div className="mb-6">
                <h3 className="mb-3 border-b border-outline-variant px-1 pb-1 text-[10px] font-bold uppercase tracking-widest text-oxblood">
                    Dependencies
                </h3>
                {renderDependencies(queryResult?.citations)}
            </div>

            <div className="mb-6">
                <h3 className="mb-3 px-1 text-[10px] font-bold uppercase tracking-widest text-oxblood">Execution Plan</h3>
                <div className="rounded border border-outline-variant bg-surface-container-low p-3">
                    <div className="space-y-3">
                        <div className="flex items-center gap-2">
                            <div className="h-1.5 w-1.5 rounded-full bg-emerald-500" />
                            <div className="h-1 flex-1 overflow-hidden rounded-full bg-outline-variant">
                                <div className="h-full w-1/4 bg-emerald-500" />
                            </div>
                            <span className="font-mono text-[9px] text-slate-500">JOIN</span>
                        </div>
                        <div className="flex items-center gap-2">
                            <div className="h-1.5 w-1.5 rounded-full bg-amber-accent" />
                            <div className="h-1 flex-1 overflow-hidden rounded-full bg-outline-variant">
                                <div className="h-full w-3/4 bg-amber-accent" />
                            </div>
                            <span className="font-mono text-[9px] text-slate-500">SCAN</span>
                        </div>
                    </div>
                    <div className="mt-3 flex items-center justify-between border-t border-outline-variant pt-2">
                        <span className="font-mono text-[9px] text-slate-500">PLACEHOLDER</span>
                        <span className="text-[9px] uppercase text-slate-400">Coming soon</span>
                    </div>
                </div>
            </div>

            <div className="mt-auto rounded border border-outline-variant bg-white p-4">
                <p className="mb-1 text-[10px] font-bold uppercase tracking-wider text-slate-500 opacity-70">System Health</p>
                <p className="mb-2 text-sm font-bold tracking-tight text-on-surface">Performance Optimal</p>
                <svg viewBox="0 0 200 32" className="h-8 w-full text-amber-accent" preserveAspectRatio="none">
                    <polyline
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="1.5"
                        points="0,22 20,18 40,20 60,12 80,16 100,8 120,12 140,6 160,10 180,4 200,8"
                    />
                </svg>
            </div>
        </aside>
    );
}
