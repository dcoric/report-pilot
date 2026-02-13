import React, { useEffect, useState } from 'react';
import { ShieldCheck, CheckCircle, AlertCircle, Play } from 'lucide-react';
import { format } from 'date-fns';
import { client } from '../lib/api/client';
import { toast } from 'sonner';

// Mock types for loose schema
interface ReleaseGateData {
    status: 'PASS' | 'FAIL' | 'WARNING';
    run_date: string;
    dataset_version: string;
    summary: {
        total_tests: number;
        passed_tests: number;
        failed_tests: number;
        accuracy_score: number;
    };
    checks: {
        id: string;
        name: string;
        description: string;
        status: 'PASS' | 'FAIL';
        threshold: string;
        actual: string;
    }[];
}

const MOCK_GATES: ReleaseGateData = {
    status: 'PASS',
    run_date: new Date().toISOString(),
    dataset_version: 'v1.2.0 (Golden Set)',
    summary: {
        total_tests: 150,
        passed_tests: 148,
        failed_tests: 2,
        accuracy_score: 98.6
    },
    checks: [
        { id: 'c1', name: 'SQL Syntax Validity', description: 'All generated SQL must be valid Postgres syntax', status: 'PASS', threshold: '100%', actual: '100%' },
        { id: 'c2', name: 'Schema Reference Accuracy', description: 'No hallucinations of table/column names', status: 'PASS', threshold: '100%', actual: '100%' },
        { id: 'c3', name: 'Execution Success Rate', description: 'Queries must execute without runtime error', status: 'PASS', threshold: '> 95%', actual: '98.6%' },
        { id: 'c4', name: 'Latency Budget (P95)', description: 'P95 generation time under 2s', status: 'PASS', threshold: '< 2000ms', actual: '1450ms' },
        { id: 'c5', name: 'Semantic Accuracy', description: 'Result matches golden label intent', status: 'FAIL', threshold: '> 90%', actual: '89.5%' } // Intentionally failed for demo
    ]
};

export const ReleaseGates: React.FC = () => {
    const [data, setData] = useState<ReleaseGateData | null>(null);
    const [loading, setLoading] = useState(true);

    useEffect(() => {
        const fetchData = async () => {
            const { data: apiData } = await client.GET('/v1/observability/release-gates');

            if (apiData && Object.keys(apiData).length > 0) {
                // Cast loose schema
                setData(apiData as unknown as ReleaseGateData);
            } else {
                // Fallback to mock if API not ready
                setData(MOCK_GATES);
            }
            setLoading(false);
        };
        fetchData();
    }, []);

    const handleRunBenchmark = () => {
        toast.info("Triggering new benchmark run... (Mock)");
        // In real app, POST to /v1/observability/benchmarks/run
    };

    if (loading) return <div className="p-8 text-center text-gray-500">Loading release status...</div>;
    if (!data) return <div className="p-8 text-center text-gray-500">No release data found.</div>;

    return (
        <div className="p-8 max-w-5xl mx-auto space-y-8">
            <div className="flex items-center justify-between">
                <div className="flex items-center gap-3">
                    <ShieldCheck className={`w-8 h-8 ${data.status === 'PASS' ? 'text-green-600' : 'text-amber-500'}`} />
                    <div>
                        <h1 className="text-2xl font-bold text-gray-900">Release Gates</h1>
                        <p className="text-sm text-gray-500">
                            Last Checked: {format(new Date(data.run_date), 'MMM d, yyyy HH:mm')} • Dataset: {data.dataset_version}
                        </p>
                    </div>
                </div>
                <button
                    onClick={handleRunBenchmark}
                    className="flex items-center gap-2 px-4 py-2 bg-blue-600 text-white rounded-md hover:bg-blue-700 transition-colors shadow-sm"
                >
                    <Play size={16} />
                    Run Benchmark
                </button>
            </div>

            {/* Overall Status Banner */}
            <div className={`p-6 rounded-lg border-l-4 shadow-sm flex items-start gap-4
                ${data.status === 'PASS' ? 'bg-green-50 border-green-500' : 'bg-amber-50 border-amber-500'}`}>
                {data.status === 'PASS' ? (
                    <CheckCircle className="text-green-600 mt-1" size={24} />
                ) : (
                    <AlertCircle className="text-amber-600 mt-1" size={24} />
                )}
                <div>
                    <h3 className={`text-lg font-bold ${data.status === 'PASS' ? 'text-green-800' : 'text-amber-800'}`}>
                        {data.status === 'PASS' ? 'Ready for Release' : 'Release Blocked / Warning'}
                    </h3>
                    <p className={`text-sm mt-1 ${data.status === 'PASS' ? 'text-green-700' : 'text-amber-700'}`}>
                        {data.status === 'PASS'
                            ? 'All critical gates passed. The system is performing within defined thresholds.'
                            : 'Some checks failed. unexpected behavior may occur.'}
                    </p>
                </div>
            </div>

            {/* Metrics Grid */}
            <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                <div className="bg-white p-4 rounded-lg border border-gray-200 shadow-sm text-center">
                    <div className="text-sm text-gray-500 uppercase tracking-wide">Total Tests</div>
                    <div className="text-2xl font-bold text-gray-900">{data.summary.total_tests}</div>
                </div>
                <div className="bg-white p-4 rounded-lg border border-gray-200 shadow-sm text-center">
                    <div className="text-sm text-gray-500 uppercase tracking-wide">Passed</div>
                    <div className="text-2xl font-bold text-green-600">{data.summary.passed_tests}</div>
                </div>
                <div className="bg-white p-4 rounded-lg border border-gray-200 shadow-sm text-center">
                    <div className="text-sm text-gray-500 uppercase tracking-wide">Failed</div>
                    <div className="text-2xl font-bold text-red-600">{data.summary.failed_tests}</div>
                </div>
                <div className="bg-white p-4 rounded-lg border border-gray-200 shadow-sm text-center">
                    <div className="text-sm text-gray-500 uppercase tracking-wide">Accuracy</div>
                    <div className="text-2xl font-bold text-blue-600">{data.summary.accuracy_score}%</div>
                </div>
            </div>

            {/* Detailed Checks */}
            <div className="bg-white rounded-lg border border-gray-200 shadow-sm overflow-hidden">
                <div className="px-6 py-4 border-b border-gray-200 bg-gray-50">
                    <h3 className="text-lg font-medium text-gray-900">Benchmark Report</h3>
                </div>
                <table className="min-w-full divide-y divide-gray-200">
                    <thead className="bg-gray-50">
                        <tr>
                            <th scope="col" className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Check</th>
                            <th scope="col" className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Threshold</th>
                            <th scope="col" className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Actual</th>
                            <th scope="col" className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Status</th>
                        </tr>
                    </thead>
                    <tbody className="bg-white divide-y divide-gray-200">
                        {data.checks.map((check) => (
                            <tr key={check.id}>
                                <td className="px-6 py-4">
                                    <div className="text-sm font-medium text-gray-900">{check.name}</div>
                                    <div className="text-sm text-gray-500">{check.description}</div>
                                </td>
                                <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-500">
                                    {check.threshold}
                                </td>
                                <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-900 font-medium">
                                    {check.actual}
                                </td>
                                <td className="px-6 py-4 whitespace-nowrap">
                                    {check.status === 'PASS' ? (
                                        <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium bg-green-100 text-green-800">
                                            PASS
                                        </span>
                                    ) : (
                                        <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium bg-red-100 text-red-800">
                                            FAIL
                                        </span>
                                    )}
                                </td>
                            </tr>
                        ))}
                    </tbody>
                </table>
            </div>
        </div>
    );
};
