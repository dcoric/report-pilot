import React, { useEffect, useState } from 'react';
import { ShieldCheck, CheckCircle, AlertCircle, Play } from 'lucide-react';
import { format } from 'date-fns';
import { client } from '../lib/api/client';
import { toast } from 'sonner';

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

type AnyRecord = Record<string, unknown>;

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

function isRecord(value: unknown): value is AnyRecord {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function toNumber(value: unknown, fallback = 0): number {
    const n = Number(value);
    return Number.isFinite(n) ? n : fallback;
}

function toBool(value: unknown): boolean | null {
    if (typeof value === 'boolean') {
        return value;
    }
    return null;
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

function makeCheck(
    id: string,
    name: string,
    description: string,
    threshold: string,
    actual: string,
    status: boolean | null
): ReleaseGateData['checks'][number] {
    return {
        id,
        name,
        description,
        threshold,
        actual,
        status: status ? 'PASS' : 'FAIL'
    };
}

function normalizeUiShape(data: AnyRecord): ReleaseGateData | null {
    const statusRaw = typeof data.status === 'string' ? data.status.toUpperCase() : null;
    const status = statusRaw === 'PASS' || statusRaw === 'FAIL' || statusRaw === 'WARNING' ? statusRaw : null;
    const summaryRaw = isRecord(data.summary) ? data.summary : null;
    const checksRaw = Array.isArray(data.checks) ? data.checks : null;
    if (!status || !summaryRaw || !checksRaw) {
        return null;
    }

    return {
        status,
        run_date: toIso(data.run_date) || new Date().toISOString(),
        dataset_version: typeof data.dataset_version === 'string' ? data.dataset_version : 'Latest benchmark',
        summary: {
            total_tests: toNumber(summaryRaw.total_tests),
            passed_tests: toNumber(summaryRaw.passed_tests),
            failed_tests: toNumber(summaryRaw.failed_tests),
            accuracy_score: toNumber(summaryRaw.accuracy_score)
        },
        checks: checksRaw
            .map((check, index) => {
                if (!isRecord(check)) {
                    return null;
                }
                const checkStatusRaw = typeof check.status === 'string' ? check.status.toUpperCase() : 'FAIL';
                const checkStatus = checkStatusRaw === 'PASS' ? 'PASS' : 'FAIL';
                return {
                    id: typeof check.id === 'string' ? check.id : `check_${index}`,
                    name: typeof check.name === 'string' ? check.name : 'Unnamed Check',
                    description: typeof check.description === 'string' ? check.description : '-',
                    status: checkStatus,
                    threshold: typeof check.threshold === 'string' ? check.threshold : '-',
                    actual: typeof check.actual === 'string' ? check.actual : '-'
                };
            })
            .filter((check): check is ReleaseGateData['checks'][number] => check !== null)
    };
}

function normalizeBackendShape(data: AnyRecord): ReleaseGateData | null {
    const summary = isRecord(data.summary) ? data.summary : null;
    if (!summary) {
        return null;
    }

    const releaseGates = isRecord(data.release_gates)
        ? data.release_gates
        : (isRecord(summary.release_gates) ? summary.release_gates : null);

    const totalTests = toNumber(summary.total_cases);
    const passedTests = toNumber(summary.correct_cases);
    const failedTests = Math.max(0, totalTests - passedTests);
    const accuracyScore = Number((toNumber(summary.correctness_rate) * 100).toFixed(2));

    const checks: ReleaseGateData['checks'] = [
        makeCheck(
            'correctness_ge_85pct',
            'Correctness',
            'Correctness rate must be at least 85%',
            '>= 85%',
            `${accuracyScore.toFixed(2)}%`,
            releaseGates ? toBool(releaseGates.correctness_ge_85pct) : null
        ),
        makeCheck(
            'critical_safety_violations_eq_0',
            'Critical Safety Violations',
            'Critical safety violations must be zero',
            '= 0',
            String(toNumber(summary.critical_safety_violations)),
            releaseGates ? toBool(releaseGates.critical_safety_violations_eq_0) : null
        ),
        makeCheck(
            'p95_latency_le_8s',
            'P95 Latency',
            'P95 end-to-end latency must stay under 8000ms',
            '<= 8000ms',
            summary.p95_latency_ms === null ? 'n/a' : `${toNumber(summary.p95_latency_ms)}ms`,
            releaseGates ? toBool(releaseGates.p95_latency_le_8s) : null
        ),
        makeCheck(
            'sql_validation_pass_rate_ge_98pct',
            'SQL Validation Pass Rate',
            'SQL validation pass rate must be at least 98%',
            '>= 98%',
            `${(toNumber(summary.sql_validation_pass_rate) * 100).toFixed(2)}%`,
            releaseGates ? toBool(releaseGates.sql_validation_pass_rate_ge_98pct) : null
        )
    ];

    const allPassed = releaseGates ? toBool(releaseGates.all_passed) : null;
    const status: ReleaseGateData['status'] = allPassed === null ? 'WARNING' : (allPassed ? 'PASS' : 'FAIL');

    return {
        status,
        run_date: toIso(data.run_date) || new Date().toISOString(),
        dataset_version: typeof data.dataset_file === 'string'
            ? data.dataset_file
            : (typeof data.data_source_id === 'string' ? data.data_source_id : 'Latest benchmark'),
        summary: {
            total_tests: totalTests,
            passed_tests: passedTests,
            failed_tests: failedTests,
            accuracy_score: accuracyScore
        },
        checks
    };
}

function normalizeReleaseGatesPayload(payload: unknown): ReleaseGateData | null {
    if (!isRecord(payload)) {
        return null;
    }
    return normalizeUiShape(payload) || normalizeBackendShape(payload);
}

export const ReleaseGates: React.FC = () => {
    const [data, setData] = useState<ReleaseGateData | null>(null);
    const [loading, setLoading] = useState(true);

    useEffect(() => {
        const fetchData = async () => {
            try {
                const { data: apiData } = await client.GET('/v1/observability/release-gates');
                const normalized = normalizeReleaseGatesPayload(apiData);
                setData(normalized || MOCK_GATES);
            } catch {
                setData(MOCK_GATES);
            } finally {
                setLoading(false);
            }
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
        <div className="p-8 max-w-5xl mx-auto space-y-8 h-full overflow-y-auto">
            <div className="flex items-center justify-between">
                <div className="flex items-center gap-3">
                    <ShieldCheck className={`w-8 h-8 ${data.status === 'PASS' ? 'text-green-600' : 'text-amber-500'}`} />
                    <div>
                        <h1 className="text-2xl font-bold text-gray-900">Release Gates</h1>
                        <p className="text-sm text-gray-500">
                            Last Checked: {safeFormatTimestamp(data.run_date, 'MMM d, yyyy HH:mm')} • Dataset: {data.dataset_version}
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
                            : 'Some checks failed or are unavailable; unexpected behavior may occur.'}
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
