import { useCallback, useEffect, useMemo, useState } from 'react';
import { CheckCircle2, ChevronLeft, ChevronRight, FileSearch, RefreshCw, XCircle } from 'lucide-react';
import { format } from 'date-fns';
import { client } from '../lib/api/client';
import type { components } from '../lib/api/types';

type AuditEvent = components['schemas']['AuditEvent'];

type Outcome = '' | 'success' | 'failure' | 'info';

const PAGE_SIZE = 50;

function actorLabel(event: AuditEvent): string {
    if (event.actor?.email) return event.actor.email;
    if (event.actor_email) return event.actor_email;
    return '—';
}

function targetLabel(event: AuditEvent): string {
    if (event.target?.email) return event.target.email;
    if (event.target_user_id) return event.target_user_id;
    return '—';
}

function outcomeBadge(outcome: AuditEvent['outcome']) {
    if (outcome === 'success') {
        return (
            <span className="inline-flex items-center gap-1 rounded-full bg-green-100 px-2 py-0.5 text-xs font-medium text-green-800">
                <CheckCircle2 size={12} /> success
            </span>
        );
    }
    if (outcome === 'failure') {
        return (
            <span className="inline-flex items-center gap-1 rounded-full bg-red-100 px-2 py-0.5 text-xs font-medium text-red-800">
                <XCircle size={12} /> failure
            </span>
        );
    }
    return <span className="inline-flex items-center rounded-full bg-gray-100 px-2 py-0.5 text-xs font-medium text-gray-700">{outcome ?? 'info'}</span>;
}

export function AuditLog() {
    const [items, setItems] = useState<AuditEvent[]>([]);
    const [total, setTotal] = useState(0);
    const [offset, setOffset] = useState(0);
    const [isLoading, setIsLoading] = useState(true);
    const [actionFilter, setActionFilter] = useState('');
    const [outcomeFilter, setOutcomeFilter] = useState<Outcome>('');
    const [expanded, setExpanded] = useState<Set<string>>(new Set());

    const fetchEvents = useCallback(async (nextOffset: number) => {
        setIsLoading(true);
        try {
            const params: Record<string, string | number> = {
                limit: PAGE_SIZE,
                offset: nextOffset,
            };
            if (actionFilter.trim()) params.action = actionFilter.trim();
            if (outcomeFilter) params.outcome = outcomeFilter;
            const { data } = await client.GET('/v1/admin/audit-events', {
                params: { query: params },
            });
            setItems(data?.items ?? []);
            setTotal(data?.total ?? 0);
            setOffset(data?.offset ?? nextOffset);
        } finally {
            setIsLoading(false);
        }
    }, [actionFilter, outcomeFilter]);

    useEffect(() => {
        void fetchEvents(0);
    }, [fetchEvents]);

    const pageInfo = useMemo(() => {
        if (total === 0) return '0 events';
        const from = offset + 1;
        const to = Math.min(offset + items.length, total);
        return `${from}–${to} of ${total}`;
    }, [offset, items.length, total]);

    function toggle(id: string) {
        setExpanded((prev) => {
            const next = new Set(prev);
            if (next.has(id)) next.delete(id);
            else next.add(id);
            return next;
        });
    }

    return (
        <div className="flex h-full flex-col p-6">
            <div className="mb-6 flex items-start justify-between">
                <div>
                    <h1 className="text-2xl font-bold text-gray-900">Audit Log</h1>
                    <p className="mt-1 text-sm text-gray-500">
                        Authentication and permission events. Newest first.
                    </p>
                </div>
                <button
                    type="button"
                    onClick={() => void fetchEvents(offset)}
                    disabled={isLoading}
                    className="flex items-center gap-2 rounded-md border border-gray-200 bg-white px-3 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-50"
                    title="Reload current page"
                >
                    <RefreshCw size={14} className={isLoading ? 'animate-spin' : ''} />
                    Refresh
                </button>
            </div>

            <div className="mb-4 flex flex-wrap items-end gap-3 rounded-lg border border-gray-200 bg-white p-3 shadow-sm">
                <label className="flex flex-col text-xs font-medium text-gray-600">
                    Action
                    <input
                        type="text"
                        value={actionFilter}
                        onChange={(e) => setActionFilter(e.target.value)}
                        placeholder="e.g. auth.login.failure"
                        className="mt-1 w-64 rounded border border-gray-300 px-2 py-1 text-sm font-normal text-gray-900 focus:border-oxblood focus:outline-none"
                    />
                </label>
                <label className="flex flex-col text-xs font-medium text-gray-600">
                    Outcome
                    <select
                        value={outcomeFilter}
                        onChange={(e) => setOutcomeFilter(e.target.value as Outcome)}
                        className="mt-1 rounded border border-gray-300 px-2 py-1 text-sm font-normal text-gray-900 focus:border-oxblood focus:outline-none"
                    >
                        <option value="">Any</option>
                        <option value="success">success</option>
                        <option value="failure">failure</option>
                        <option value="info">info</option>
                    </select>
                </label>
                <button
                    type="button"
                    onClick={() => void fetchEvents(0)}
                    className="rounded-md bg-oxblood px-3 py-1.5 text-sm font-medium text-white hover:bg-oxblood-deep"
                >
                    Apply
                </button>
                {(actionFilter || outcomeFilter) && (
                    <button
                        type="button"
                        onClick={() => { setActionFilter(''); setOutcomeFilter(''); }}
                        className="text-xs text-gray-500 hover:text-gray-700"
                    >
                        Clear
                    </button>
                )}
            </div>

            <div className="flex-1 overflow-hidden rounded-lg border border-gray-200 bg-white shadow-sm">
                <div className="grid grid-cols-12 gap-4 border-b border-gray-200 bg-gray-50 px-4 py-3 text-xs font-medium uppercase tracking-wider text-gray-500">
                    <div className="col-span-2">When</div>
                    <div className="col-span-3">Action</div>
                    <div className="col-span-1">Outcome</div>
                    <div className="col-span-3">Actor</div>
                    <div className="col-span-3">Target / details</div>
                </div>

                <div className="h-full overflow-y-auto">
                    {isLoading ? (
                        <div className="flex h-64 flex-col items-center justify-center text-gray-500">
                            <RefreshCw className="mb-2 animate-spin" size={20} />
                            <p>Loading…</p>
                        </div>
                    ) : items.length === 0 ? (
                        <div className="flex h-64 flex-col items-center justify-center text-gray-500">
                            <FileSearch size={40} className="mb-3 opacity-30" />
                            <p className="text-sm font-medium">No audit events match these filters</p>
                        </div>
                    ) : (
                        items.map((event) => {
                            const isOpen = expanded.has(event.id);
                            return (
                                <div key={event.id} className="border-b border-gray-100 last:border-b-0">
                                    <button
                                        type="button"
                                        onClick={() => toggle(event.id)}
                                        className="grid w-full grid-cols-12 items-center gap-4 px-4 py-2 text-left text-sm hover:bg-gray-50"
                                    >
                                        <div className="col-span-2 text-xs text-gray-600">
                                            {format(new Date(event.created_at), 'yyyy-MM-dd HH:mm:ss')}
                                        </div>
                                        <div className="col-span-3 font-mono text-xs text-gray-900">{event.action}</div>
                                        <div className="col-span-1">{outcomeBadge(event.outcome)}</div>
                                        <div className="col-span-3 truncate text-xs text-gray-700" title={actorLabel(event)}>
                                            {actorLabel(event)}
                                        </div>
                                        <div className="col-span-3 truncate text-xs text-gray-600">
                                            {targetLabel(event)}
                                        </div>
                                    </button>
                                    {isOpen && (
                                        <div className="bg-gray-50 px-4 py-3 text-xs text-gray-700">
                                            <dl className="grid grid-cols-2 gap-x-4 gap-y-1">
                                                <dt className="text-gray-500">Event ID</dt>
                                                <dd className="font-mono">{event.id}</dd>
                                                {event.ip_address && (
                                                    <>
                                                        <dt className="text-gray-500">IP</dt>
                                                        <dd className="font-mono">{event.ip_address}</dd>
                                                    </>
                                                )}
                                                {event.user_agent && (
                                                    <>
                                                        <dt className="text-gray-500">User-Agent</dt>
                                                        <dd className="truncate font-mono" title={event.user_agent}>{event.user_agent}</dd>
                                                    </>
                                                )}
                                                {event.actor_user_id && (
                                                    <>
                                                        <dt className="text-gray-500">Actor ID</dt>
                                                        <dd className="font-mono">{event.actor_user_id}</dd>
                                                    </>
                                                )}
                                                {event.target_user_id && (
                                                    <>
                                                        <dt className="text-gray-500">Target ID</dt>
                                                        <dd className="font-mono">{event.target_user_id}</dd>
                                                    </>
                                                )}
                                            </dl>
                                            <div className="mt-2">
                                                <div className="mb-1 text-gray-500">Details</div>
                                                <pre className="overflow-x-auto rounded bg-white p-2 font-mono text-[11px] text-gray-800">
{JSON.stringify(event.details ?? {}, null, 2)}
                                                </pre>
                                            </div>
                                        </div>
                                    )}
                                </div>
                            );
                        })
                    )}
                </div>
            </div>

            <div className="mt-4 flex items-center justify-between text-xs text-gray-600">
                <span>{pageInfo}</span>
                <div className="flex items-center gap-2">
                    <button
                        type="button"
                        onClick={() => void fetchEvents(Math.max(0, offset - PAGE_SIZE))}
                        disabled={offset === 0 || isLoading}
                        className="inline-flex items-center gap-1 rounded border border-gray-200 bg-white px-2 py-1 hover:bg-gray-50 disabled:opacity-50"
                    >
                        <ChevronLeft size={14} /> Prev
                    </button>
                    <button
                        type="button"
                        onClick={() => void fetchEvents(offset + PAGE_SIZE)}
                        disabled={offset + items.length >= total || isLoading}
                        className="inline-flex items-center gap-1 rounded border border-gray-200 bg-white px-2 py-1 hover:bg-gray-50 disabled:opacity-50"
                    >
                        Next <ChevronRight size={14} />
                    </button>
                </div>
            </div>
        </div>
    );
}
