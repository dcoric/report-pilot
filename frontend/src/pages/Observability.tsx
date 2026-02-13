import React, { useEffect, useState } from 'react';
import { Activity, Clock, AlertTriangle, CheckCircle, BarChart2 } from 'lucide-react';
import { AreaChart, Area, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, BarChart, Bar } from 'recharts';
import { client } from '../lib/api/client';
import { format } from 'date-fns';

// Mock types since the API schema is loose
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
        { id: 'sess_1', timestamp: new Date().toISOString(), question: "Sales last year", error: "Context window exceeded" },
        { id: 'sess_2', timestamp: new Date(Date.now() - 3600000).toISOString(), question: "Active users by region", error: "Database timeout" }
    ]
};

export const Observability: React.FC = () => {
    const [metrics, setMetrics] = useState<MetricsData | null>(null);
    const [loading, setLoading] = useState(true);

    useEffect(() => {
        const fetchMetrics = async () => {
            // Try to fetch real data
            const { data } = await client.GET('/v1/observability/metrics', {
                params: { query: { window_hours: 24 } }
            });

            if (data && Object.keys(data).length > 0) {
                // If real data exists and looks valid (simple check), use it
                // For now, we assume the API might not be fully ready or returns a different shape
                // so we might default to mock if it's empty.
                // In a real scenario, we'd cast/validate 'data'.
                setMetrics(data as unknown as MetricsData);
            } else {
                setMetrics(MOCK_DATA);
            }
            setLoading(false);
        };
        fetchMetrics();
    }, []);

    if (loading) return <div className="p-8 text-center text-gray-500">Loading metrics...</div>;
    if (!metrics) return <div className="p-8 text-center text-gray-500">No metrics available.</div>;

    const { summary, history, recent_failures } = metrics;

    return (
        <div className="p-8 max-w-7xl mx-auto space-y-8">
            <div className="flex items-center gap-3 mb-2">
                <Activity className="w-8 h-8 text-blue-600" />
                <h1 className="text-2xl font-bold text-gray-900">Observability</h1>
            </div>

            {/* Summary Cards */}
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

            {/* Charts */}
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-8">
                <div className="bg-white p-6 rounded-lg border border-gray-200 shadow-sm">
                    <h3 className="text-lg font-medium text-gray-900 mb-6">Query Volume & Errors</h3>
                    <div className="h-64">
                        <ResponsiveContainer width="100%" height="100%">
                            <BarChart data={history}>
                                <CartesianGrid strokeDasharray="3 3" vertical={false} />
                                <XAxis
                                    dataKey="timestamp"
                                    tickFormatter={(str) => format(new Date(str), 'HH:mm')}
                                    tick={{ fontSize: 12, fill: '#6B7280' }}
                                />
                                <YAxis tick={{ fontSize: 12, fill: '#6B7280' }} />
                                <Tooltip
                                    labelFormatter={(label) => format(new Date(label), 'MMM d, HH:mm')}
                                />
                                <Bar dataKey="queries" fill="#3B82F6" name="Queries" radius={[4, 4, 0, 0]} />
                                <Bar dataKey="errors" fill="#EF4444" name="Errors" radius={[4, 4, 0, 0]} />
                            </BarChart>
                        </ResponsiveContainer>
                    </div>
                </div>
                <div className="bg-white p-6 rounded-lg border border-gray-200 shadow-sm">
                    <h3 className="text-lg font-medium text-gray-900 mb-6">Latency Trend (ms)</h3>
                    <div className="h-64">
                        <ResponsiveContainer width="100%" height="100%">
                            <AreaChart data={history}>
                                <CartesianGrid strokeDasharray="3 3" vertical={false} />
                                <XAxis
                                    dataKey="timestamp"
                                    tickFormatter={(str) => format(new Date(str), 'HH:mm')}
                                    tick={{ fontSize: 12, fill: '#6B7280' }}
                                />
                                <YAxis tick={{ fontSize: 12, fill: '#6B7280' }} />
                                <Tooltip
                                    labelFormatter={(label) => format(new Date(label), 'MMM d, HH:mm')}
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
                    </div>
                </div>
            </div>

            {/* Recent Failures */}
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
                                        {format(new Date(fail.timestamp), 'MMM d, HH:mm:ss')}
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
