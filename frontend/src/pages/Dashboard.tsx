import React from 'react';
import { Activity, ShieldCheck } from 'lucide-react';
import { useSearchParams } from 'react-router-dom';
import { Observability } from './Observability';
import { ReleaseGates } from './ReleaseGates';

export const Dashboard: React.FC = () => {
    const [searchParams, setSearchParams] = useSearchParams();
    const tab = searchParams.get('tab') === 'release-gates' ? 'release-gates' : 'observability';

    const setTab = (nextTab: 'observability' | 'release-gates') => {
        setSearchParams({ tab: nextTab });
    };

    return (
        <div className="p-6 h-full overflow-y-auto">
            <h1 className="text-2xl font-bold text-gray-900 mb-1">Dashboard</h1>
            <p className="text-sm text-gray-500 mb-6">Operational visibility for query quality, reliability, and release readiness.</p>

            <div className="inline-flex items-center rounded-lg border border-gray-200 bg-white p-1 mb-6">
                <button
                    onClick={() => setTab('observability')}
                    className={`inline-flex items-center gap-2 rounded-md px-4 py-2 text-sm font-medium transition-colors ${
                        tab === 'observability'
                            ? 'bg-blue-600 text-white shadow-sm'
                            : 'text-gray-600 hover:bg-gray-100'
                    }`}
                >
                    <Activity size={16} />
                    Observability
                </button>
                <button
                    onClick={() => setTab('release-gates')}
                    className={`inline-flex items-center gap-2 rounded-md px-4 py-2 text-sm font-medium transition-colors ${
                        tab === 'release-gates'
                            ? 'bg-blue-600 text-white shadow-sm'
                            : 'text-gray-600 hover:bg-gray-100'
                    }`}
                >
                    <ShieldCheck size={16} />
                    Release Gates
                </button>
            </div>

            {tab === 'observability' ? <Observability embedded /> : <ReleaseGates embedded />}
        </div>
    );
};
