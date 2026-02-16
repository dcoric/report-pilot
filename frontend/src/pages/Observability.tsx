import React, { useEffect, useState } from 'react';
import { Activity, Clock, AlertTriangle, CheckCircle, BarChart2 } from 'lucide-react';
import { AreaChart, Area, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, BarChart, Bar } from 'recharts';
import { client } from '../lib/api/client';
import { format } from 'date-fns';

interface MetricsData {
    summary: {
        total_queries: number;
        avg_latency_ms: number;
        success_rate: number;
        error_count: number;
    };
    history: {
        timestamp: string;
        queries: number;
        latency: number;
        errors: number;
    }[];
    recent_failures: {
        id: string;
        timestamp: string;
        question: string;
        error: string;
    }[];
}

type AnyRecord = Record<string, unknown>;

const MOCK_DATA: MetricsData = {
    summary: {
        total_queries: 1245,
        avg_latency_ms: 342,
        success_rate: 98.5,
        error_count: 18
    },
    history: Array.from({ length: 24 }, (_, i) => ({
        timestamp: new Date(Date.now() - (23 - i) * 3600000).toISOString(),
        queries: Math.floor(Math.random() * 50) + 10,
        latency: 200 + Math.random() * 300,
        errors: Math.random() > 0.8 ? Math.floor(Math.random() * 3) : 0
    })),
    recent_failures: [
        { id: 'sess_1', timestamp: new Date().toISOString(), question: 'Sales last year', error: 'Context window exceeded' },
        { id: 'sess_2', timestamp: new Date(Date.now() - 3600000).toISOString(), question: 'Active users by region', error: 'Database timeout' }
    ]
};

function isRecord(value: unknown): value is AnyRecord {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function toNumber(value: unknown, fallback = 0): number {
    const n = Number(value);
    return Number.isFinite(n) ? n : fallback;
}

function toIso(value: unknown): string | null {
    if (typeof value !== 'string') {
        return null;
    }
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function safeFormatTimestamp(value: string, pattern: string): string {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? '-' : format(date, pattern);
}

function normalizeHistory(value: unknown): MetricsData['history'] {
    if (!Array.isArray(value)) {
        return [];
    }

    return value
        .map((item) => {
            if (!isRecord(item)) {
                return null;
            }
            const timestamp = toIso(item.timestamp);
            if (!timestamp) {
                return null;
            }
            return {
                timestamp,
                queries: toNumber(item.queries),
                latency: toNumber(item.latency),
                errors: toNumber(item.errors)
            };
        })
        .filter((item): item is MetricsData['history'][number] => item !== null);
}

function normalizeFailures(value: unknown): MetricsData['recent_failures'] {
    if (!Array.isArray(value)) {
        return [];
    }

    return value
        .map((item, index) => {
            if (!isRecord(item)) {
                return null;
            }
            const timestamp = toIso(item.timestamp);
            if (!timestamp) {
                return null;
            }
            return {
                id: typeof item.id === 'string' ? item.id : `failure_${index}`,
                timestamp,
                question: typeof item.question === 'string' ? item.question : '-',
                error: typeof item.error === 'string' ? item.error : 'Unknown error'
            };
        })
        .filter((item): item is MetricsData['recent_failures'][number] => item !== null);
}

function normalizeLegacyShape(data: AnyRecord): MetricsData | null {
    const summaryRaw = isRecord(data.summary) ? data.summary : null;
    if (!summaryRaw) {
        return null;
    }

    return {
        summary: {
            total_queries: toNumber(summaryRaw.total_queries),
            avg_latency_ms: toNumber(summaryRaw.avg_latency_ms),
            success_rate: toNumber(summaryRaw.success_rate),
            error_count: toNumber(summaryRaw.error_count)
        },
        history: normalizeHistory(data.history),
        recent_failures: normalizeFailures(data.recent_failures)
    };
}

function normalizeBackendShape(data: AnyRecord): MetricsData | null {
    const totals = isRecord(data.totals) ? data.totals : null;
    const latency = isRecord(data.latency_ms) ? data.latency_ms : null;
    const generation = latency && isRecord(latency.generation) ? latency.generation : null;

    if (!totals || !generation) {
        return null;
    }

    const totalQueries = toNumber(totals.attempts);

    let errorCount = 0;
    if (Array.isArray(data.provider_failures)) {
        for (const item of data.provider_failures) {
            if (!isRecord(item)) {
                continue;
            }
            errorCount += toNumber(item.failures);
        }
    }

    const successRate = totalQueries > 0
        ? Math.max(0, Number((((totalQueries - errorCount) / totalQueries) * 100).toFixed(2)))
        : 100;

    return {
        summary: {
            total_queries: totalQueries,
            avg_latency_ms: toNumber(generation.avg),
            success_rate: successRate,
            error_count: errorCount
        },
        history: [],
        recent_failures: []
    };
}

function normalizeMetricsPayload(payload: unknown): MetricsData | null {
    if (!isRecord(payload)) {
        return null;
    }

    return normalizeLegacyShape(payload) || normalizeBackendShape(payload);
}

interface ObservabilityProps {
    embedded?: boolean;
}

export const Observability: React.FC<ObservabilityProps> = ({ embedded = false }) => {
    const [metrics, setMetrics] = useState<MetricsData | null>(null);
    const [loading, setLoading] = useState(true);

    useEffect(() => {
        const fetchMetrics = async () => {
            try {
                const { data } = await client.GET('/v1/observability/metrics', {
                    params: { query: { window_hours: 24 } }
                });

                const normalized = normalizeMetricsPayload(data);
                setMetrics(normalized || MOCK_DATA);
            } catch {
                setMetrics(MOCK_DATA);
            } finally {
                setLoading(false);
            }
        };

        fetchMetrics();
    }, []);

    if (loading) return <div className={embedded ? 'py-10 text-center text-gray-500' : 'p-8 text-center text-gray-500'}>Loading metrics...</div>;
    if (!metrics) return <div className={embedded ? 'py-10 text-center text-gray-500' : 'p-8 text-center text-gray-500'}>No metrics available.</div>;

    const { summary, history, recent_failures } = metrics;

    return (
        <div className={embedded ? 'space-y-8 h-full overflow-y-auto' : 'p-8 max-w-7xl mx-auto space-y-8 h-full overflow-y-auto'}>
            {!embedded && (
                <div className="flex items-center gap-3 mb-2">
                    <Activity className="w-8 h-8 text-blue-600" />
                    <h1 className="text-2xl font-bold text-gray-900">Observability</h1>
                </div>
            )}

            <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
                <div className="bg-white p-6 rounded-lg border border-gray-200 shadow-sm">
                    <div className="flex items-center justify-between">
                        <div>
                            <p className="text-sm font-medium text-gray-500">Total Queries (24h)</p>
                            <p className="text-2xl font-bold text-gray-900 mt-1">{summary.total_queries}</p>
                        </div>
                        <div className="p-2 bg-blue-50 text-blue-600 rounded-lg">
                            <BarChart2 size={20} />
                        </div>
                    </div>
                </div>
                <div className="bg-white p-6 rounded-lg border border-gray-200 shadow-sm">
                    <div className="flex items-center justify-between">
                        <div>
                            <p className="text-sm font-medium text-gray-500">Avg Latency</p>
                            <p className="text-2xl font-bold text-gray-900 mt-1">{Math.round(summary.avg_latency_ms)} ms</p>
                        </div>
                        <div className="p-2 bg-purple-50 text-purple-600 rounded-lg">
                            <Clock size={20} />
                        </div>
                    </div>
                </div>
                <div className="bg-white p-6 rounded-lg border border-gray-200 shadow-sm">
                    <div className="flex items-center justify-between">
                        <div>
                            <p className="text-sm font-medium text-gray-500">Success Rate</p>
                            <p className="text-2xl font-bold text-green-600 mt-1">{summary.success_rate}%</p>
                        </div>
                        <div className="p-2 bg-green-50 text-green-600 rounded-lg">
                            <CheckCircle size={20} />
                        </div>
                    </div>
                </div>
                <div className="bg-white p-6 rounded-lg border border-gray-200 shadow-sm">
                    <div className="flex items-center justify-between">
                        <div>
                            <p className="text-sm font-medium text-gray-500">Errors</p>
                            <p className="text-2xl font-bold text-red-600 mt-1">{summary.error_count}</p>
                        </div>
                        <div className="p-2 bg-red-50 text-red-600 rounded-lg">
                            <AlertTriangle size={20} />
                        </div>
                    </div>
                </div>
            </div>

            <div className="grid grid-cols-1 lg:grid-cols-2 gap-8">
                <div className="bg-white p-6 rounded-lg border border-gray-200 shadow-sm">
                    <h3 className="text-lg font-medium text-gray-900 mb-6">Query Volume & Errors</h3>
                    <div className="h-64">
                        {history.length === 0 ? (
                            <div className="h-full flex items-center justify-center text-sm text-gray-500">No time-series data available.</div>
                        ) : (
                            <ResponsiveContainer width="100%" height="100%">
                                <BarChart data={history}>
                                    <CartesianGrid strokeDasharray="3 3" vertical={false} />
                                    <XAxis
                                        dataKey="timestamp"
                                        tickFormatter={(str) => safeFormatTimestamp(String(str), 'HH:mm')}
                                        tick={{ fontSize: 12, fill: '#6B7280' }}
                                    />
                                    <YAxis tick={{ fontSize: 12, fill: '#6B7280' }} />
                                    <Tooltip
                                        labelFormatter={(label) => safeFormatTimestamp(String(label), 'MMM d, HH:mm')}
                                    />
                                    <Bar dataKey="queries" fill="#3B82F6" name="Queries" radius={[4, 4, 0, 0]} />
                                    <Bar dataKey="errors" fill="#EF4444" name="Errors" radius={[4, 4, 0, 0]} />
                                </BarChart>
                            </ResponsiveContainer>
                        )}
                    </div>
                </div>
                <div className="bg-white p-6 rounded-lg border border-gray-200 shadow-sm">
                    <h3 className="text-lg font-medium text-gray-900 mb-6">Latency Trend (ms)</h3>
                    <div className="h-64">
                        {history.length === 0 ? (
                            <div className="h-full flex items-center justify-center text-sm text-gray-500">No latency trend data available.</div>
                        ) : (
                            <ResponsiveContainer width="100%" height="100%">
                                <AreaChart data={history}>
                                    <CartesianGrid strokeDasharray="3 3" vertical={false} />
                                    <XAxis
                                        dataKey="timestamp"
                                        tickFormatter={(str) => safeFormatTimestamp(String(str), 'HH:mm')}
                                        tick={{ fontSize: 12, fill: '#6B7280' }}
                                    />
                                    <YAxis tick={{ fontSize: 12, fill: '#6B7280' }} />
                                    <Tooltip
                                        labelFormatter={(label) => safeFormatTimestamp(String(label), 'MMM d, HH:mm')}
                                    />
                                    <Area
                                        type="monotone"
                                        dataKey="latency"
                                        stroke="#8B5CF6"
                                        fill="#8B5CF6"
                                        fillOpacity={0.1}
                                        name="Latency (ms)"
                                    />
                                </AreaChart>
                            </ResponsiveContainer>
                        )}
                    </div>
                </div>
            </div>

            <div className="bg-white rounded-lg border border-gray-200 shadow-sm overflow-hidden">
                <div className="px-6 py-4 border-b border-gray-200 bg-gray-50">
                    <h3 className="text-lg font-medium text-gray-900">Recent Failures</h3>
                </div>
                <div className="overflow-x-auto">
                    <table className="min-w-full divide-y divide-gray-200">
                        <thead className="bg-gray-50">
                            <tr>
                                <th scope="col" className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Timestamp</th>
                                <th scope="col" className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Question</th>
                                <th scope="col" className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Error</th>
                            </tr>
                        </thead>
                        <tbody className="bg-white divide-y divide-gray-200">
                            {recent_failures.map((fail) => (
                                <tr key={fail.id}>
                                    <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-500">
                                        {safeFormatTimestamp(fail.timestamp, 'MMM d, HH:mm:ss')}
                                    </td>
                                    <td className="px-6 py-4 text-sm text-gray-900 max-w-xs truncate">
                                        {fail.question}
                                    </td>
                                    <td className="px-6 py-4 text-sm text-red-600 font-medium">
                                        {fail.error}
                                    </td>
                                </tr>
                            ))}
                            {recent_failures.length === 0 && (
                                <tr>
                                    <td colSpan={3} className="px-6 py-4 text-center text-sm text-gray-500">
                                        No recent failures logged.
                                    </td>
                                </tr>
                            )}
                        </tbody>
                    </table>
                </div>
            </div>
        </div>
    );
};
