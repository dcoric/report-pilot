import React, { useState, useEffect } from 'react';
import { Play, Copy, RotateCcw, Eye, Loader2, CheckCircle2, Calendar } from 'lucide-react';
import { toast } from 'sonner';
import { client } from '../lib/api/client';
import { Sidebar } from '../components/Layout/Sidebar';
import { TopHeader } from '../components/Layout/TopHeader';
import type { components } from '../lib/api/types';

// Types
type DataSource = components['schemas']['DataSourceListResponse']['items'][number];
type RunResponse = components['schemas']['RunSessionResponse'];

type TabType = 'results' | 'metadata' | 'citations' | 'query-plan';

export const QueryWorkspace: React.FC = () => {
    // --- State ---
    const [dataSources, setDataSources] = useState<DataSource[]>([]);
    const [selectedDataSourceId, setSelectedDataSourceId] = useState<string>('');

    const [question, setQuestion] = useState('');
    const [sessionId, setSessionId] = useState<string | null>(null);
    const [generatedSql, setGeneratedSql] = useState('');
    const [originalSql, setOriginalSql] = useState(''); // For reset
    const [queryResult, setQueryResult] = useState<RunResponse | null>(null);

    const [isGenerating, setIsGenerating] = useState(false);
    const [isRunning, setIsRunning] = useState(false);
    const [activeTab, setActiveTab] = useState<TabType>('results');

    // Query controls
    const [provider, setProvider] = useState('OpenAI');
    const [model, setModel] = useState('gpt-4');
    const [maxRows, setMaxRows] = useState(1000);
    const [timeout, setTimeout] = useState(60);
    const [isReadOnly, setIsReadOnly] = useState(false);

    // Export controls
    const [exportFormat, setExportFormat] = useState<'json' | 'csv' | 'xlsx' | 'tsv' | 'parquet'>('csv');
    const [isExporting, setIsExporting] = useState(false);

    // --- Effects ---
    useEffect(() => {
        const fetchDataSources = async () => {
            const { data } = await client.GET('/v1/data-sources');
            if (data?.items) {
                setDataSources(data.items);
                if (data.items.length > 0) setSelectedDataSourceId(data.items[0].id);
            }
        };
        fetchDataSources();
    }, []);

    // --- Actions ---
    const handleAsk = async () => {
        if (!selectedDataSourceId || !question.trim()) return;

        setIsGenerating(true);
        setGeneratedSql('');
        setQueryResult(null);

        try {
            const { data, error } = await client.POST('/v1/query/sessions', {
                body: {
                    data_source_id: selectedDataSourceId,
                    question: question
                }
            });

            if (error) {
                toast.error("Failed to generate SQL");
                console.error(error);
            } else if (data) {
                setSessionId(data.session_id);
                await generateSql(data.session_id);
            }
        } catch (err) {
            console.error(err);
            toast.error("An error occurred");
        } finally {
            setIsGenerating(false);
        }
    };

    const generateSql = async (sessId: string) => {
        const { data } = await client.POST('/v1/query/sessions/{sessionId}/run', {
            params: { path: { sessionId: sessId } },
            body: {}
        });

        if (data) {
            setGeneratedSql(data.sql);
            setOriginalSql(data.sql);
            setQueryResult(data);
        }
    };

    const handleRun = async () => {
        if (!sessionId) return;

        setIsRunning(true);
        try {
            const { data } = await client.POST('/v1/query/sessions/{sessionId}/run', {
                params: { path: { sessionId } },
                body: {}
            });

            if (data) {
                setGeneratedSql(data.sql);
                setQueryResult(data);
                toast.success('Query executed successfully');
            }
        } catch (e) {
            console.error(e);
            toast.error("Run failed");
        } finally {
            setIsRunning(false);
        }
    };

    const handleCopy = async () => {
        try {
            await navigator.clipboard.writeText(generatedSql);
            toast.success('SQL copied to clipboard');
        } catch (err) {
            toast.error('Failed to copy');
        }
    };

    const handleReset = () => {
        setGeneratedSql(originalSql);
        toast.info('SQL reset to original');
    };

    const handleExport = async () => {
        if (!sessionId || !queryResult?.rows.length) return;

        setIsExporting(true);
        try {
            const response = await fetch(`/v1/query/sessions/${sessionId}/export`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ format: exportFormat })
            });

            if (!response.ok) throw new Error('Export failed');

            const blob = await response.blob();
            const url = window.URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;

            const disposition = response.headers.get('Content-Disposition');
            let filename = `export-${sessionId}.${exportFormat}`;
            if (disposition && disposition.indexOf('filename=') !== -1) {
                const matches = /filename="([^"]*)"/.exec(disposition);
                if (matches && matches[1]) filename = matches[1];
            }

            a.download = filename;
            document.body.appendChild(a);
            a.click();
            window.URL.revokeObjectURL(url);
            document.body.removeChild(a);

            toast.success(`Exported as ${exportFormat.toUpperCase()}`);
        } catch (err: any) {
            toast.error(err.message || "Failed to export");
        } finally {
            setIsExporting(false);
        }
    };

    return (
        <div className="h-screen flex flex-col bg-gray-50 overflow-hidden">
            {/* Top Header */}
            <TopHeader
                currentConnection={selectedDataSourceId}
                dataSources={dataSources}
                onConnectionChange={setSelectedDataSourceId}
            />

            {/* Main Layout: Sidebar + Workspace */}
            <div className="flex-1 flex overflow-hidden">
                {/* Left Sidebar */}
                <Sidebar
                    dataSources={dataSources}
                    selectedDataSourceId={selectedDataSourceId}
                    onSelectDataSource={setSelectedDataSourceId}
                />

                {/* Main Workspace */}
                <div className="flex-1 flex flex-col overflow-hidden">
                    {/* SECTION 1: Prompt Section */}
                    <div className="bg-white border-b border-gray-200 p-4 flex-shrink-0">
                        <div className="max-w-6xl mx-auto">
                            <div className="flex justify-between items-center mb-2">
                                <h2 className="text-sm font-semibold text-gray-700">Prompt section</h2>
                                <label className="flex items-center gap-2 text-xs text-gray-600">
                                    <input
                                        type="checkbox"
                                        checked={isReadOnly}
                                        onChange={(e) => setIsReadOnly(e.target.checked)}
                                        className="rounded"
                                    />
                                    Read only
                                </label>
                            </div>

                            {/* Question Input */}
                            <textarea
                                className="w-full px-4 py-3 text-sm border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent resize-none mb-3"
                                rows={3}
                                placeholder="Enter your question here..."
                                value={question}
                                onChange={(e) => setQuestion(e.target.value)}
                                onKeyDown={(e) => {
                                    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                                        e.preventDefault();
                                        handleAsk();
                                    }
                                }}
                                disabled={isReadOnly}
                            />

                            {/* Controls Row */}
                            <div className="flex items-center gap-4 flex-wrap">
                                <div className="flex items-center gap-2">
                                    <label className="text-xs font-medium text-gray-600">Provider:</label>
                                    <select
                                        value={provider}
                                        onChange={(e) => setProvider(e.target.value)}
                                        className="px-2 py-1 text-xs border border-gray-300 rounded focus:outline-none focus:ring-2 focus:ring-blue-500"
                                    >
                                        <option>OpenAI</option>
                                        <option>Anthropic</option>
                                    </select>
                                </div>

                                <div className="flex items-center gap-2">
                                    <label className="text-xs font-medium text-gray-600">Model:</label>
                                    <select
                                        value={model}
                                        onChange={(e) => setModel(e.target.value)}
                                        className="px-2 py-1 text-xs border border-gray-300 rounded focus:outline-none focus:ring-2 focus:ring-blue-500"
                                    >
                                        <option>gpt-4</option>
                                        <option>gpt-3.5-turbo</option>
                                        <option>claude-3-opus</option>
                                    </select>
                                </div>

                                <div className="flex items-center gap-2">
                                    <label className="text-xs font-medium text-gray-600">Max Rows:</label>
                                    <input
                                        type="number"
                                        value={maxRows}
                                        onChange={(e) => setMaxRows(Number(e.target.value))}
                                        className="w-20 px-2 py-1 text-xs border border-gray-300 rounded focus:outline-none focus:ring-2 focus:ring-blue-500"
                                    />
                                </div>

                                <div className="flex items-center gap-2">
                                    <label className="text-xs font-medium text-gray-600">Timeout:</label>
                                    <input
                                        type="number"
                                        value={timeout}
                                        onChange={(e) => setTimeout(Number(e.target.value))}
                                        className="w-16 px-2 py-1 text-xs border border-gray-300 rounded focus:outline-none focus:ring-2 focus:ring-blue-500"
                                    />
                                    <span className="text-xs text-gray-500">s</span>
                                </div>

                                <button className="ml-auto px-3 py-1.5 text-xs font-medium text-gray-700 bg-white border border-gray-300 rounded hover:bg-gray-50">
                                    Prompt History
                                </button>
                            </div>
                        </div>
                    </div>

                    {/* SECTION 2: SQL Section */}
                    <div className="bg-white border-b border-gray-200 flex-shrink-0">
                        <div className="px-4 py-2 bg-gray-50 border-b border-gray-200 flex justify-between items-center">
                            <span className="text-xs font-semibold text-gray-700">SQL section</span>
                            <div className="flex items-center gap-2">
                                <button
                                    onClick={handleCopy}
                                    className="px-2 py-1 text-xs font-medium text-gray-700 bg-white border border-gray-300 rounded hover:bg-gray-50"
                                    disabled={!generatedSql}
                                    title="Copy SQL"
                                >
                                    <Copy size={14} />
                                </button>
                                <button
                                    onClick={handleReset}
                                    className="px-2 py-1 text-xs font-medium text-gray-700 bg-white border border-gray-300 rounded hover:bg-gray-50"
                                    disabled={!generatedSql}
                                    title="Reset to original"
                                >
                                    <RotateCcw size={14} />
                                </button>
                                <button className="px-2 py-1 text-xs font-medium text-gray-700 bg-white border border-gray-300 rounded hover:bg-gray-50">
                                    <Eye size={14} />
                                </button>
                                <button className="px-2 py-1 text-xs font-medium text-gray-600 hover:text-gray-800">
                                    Format SQL
                                </button>
                                <button
                                    onClick={handleRun}
                                    disabled={isRunning || !generatedSql}
                                    className="flex items-center gap-1.5 px-4 py-1.5 bg-blue-600 text-white text-xs font-medium rounded hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed"
                                >
                                    {isRunning ? <Loader2 size={14} className="animate-spin" /> : <Play size={14} />}
                                    Run
                                </button>
                            </div>
                        </div>

                        {/* SQL Editor */}
                        <div className="bg-gray-50">
                            {isGenerating ? (
                                <div className="h-40 flex items-center justify-center text-gray-400 text-sm">
                                    <Loader2 className="animate-spin mr-2" size={16} />
                                    Generating SQL...
                                </div>
                            ) : generatedSql ? (
                                <div>
                                    <div className="px-4 py-1 text-xs text-gray-500 bg-gray-100 border-b border-gray-200">
                                        Generated SQL
                                    </div>
                                    <textarea
                                        className="w-full h-40 p-4 font-mono text-xs text-gray-800 bg-white resize-none focus:outline-none border-b border-gray-200"
                                        value={generatedSql}
                                        onChange={(e) => setGeneratedSql(e.target.value)}
                                        spellCheck={false}
                                        readOnly={isReadOnly}
                                    />
                                </div>
                            ) : (
                                <div className="h-40 flex items-center justify-center text-gray-400 text-sm">
                                    Enter a question and press Enter or click Ask to generate SQL
                                </div>
                            )}
                        </div>
                    </div>

                    {/* SECTION 3: Result Section */}
                    <div className="flex-1 flex flex-col overflow-hidden bg-white">
                        {/* Tab Navigation */}
                        <div className="border-b border-gray-200 flex items-center px-4">
                            <div className="text-xs font-semibold text-gray-700 py-2 mr-4">Result section</div>
                            <div className="flex gap-4">
                                {(['results', 'metadata', 'citations', 'query-plan'] as TabType[]).map(tab => (
                                    <button
                                        key={tab}
                                        onClick={() => setActiveTab(tab)}
                                        className={`px-3 py-2 text-xs font-medium border-b-2 transition-colors ${
                                            activeTab === tab
                                                ? 'border-blue-600 text-blue-600'
                                                : 'border-transparent text-gray-600 hover:text-gray-800'
                                        }`}
                                    >
                                        {tab === 'results' && 'Results'}
                                        {tab === 'metadata' && 'Metadata'}
                                        {tab === 'citations' && 'Citations'}
                                        {tab === 'query-plan' && 'Query Plan'}
                                    </button>
                                ))}
                            </div>
                        </div>

                        {/* Tab Content */}
                        <div className="flex-1 overflow-auto">
                            {activeTab === 'results' && (
                                <div className="p-0">
                                    {!queryResult && !isRunning && (
                                        <div className="h-full flex flex-col items-center justify-center text-gray-400 p-8">
                                            <p>No results yet. Run a query to see results.</p>
                                        </div>
                                    )}

                                    {isRunning && (
                                        <div className="h-full flex items-center justify-center text-gray-400">
                                            <Loader2 className="animate-spin mr-2" size={20} />
                                            Executing query...
                                        </div>
                                    )}

                                    {queryResult && (
                                        <table className="min-w-full divide-y divide-gray-200">
                                            <thead className="bg-gray-50 sticky top-0">
                                                <tr>
                                                    <th className="px-4 py-2 text-left text-xs font-medium text-gray-500 uppercase bg-gray-100 border-r border-gray-200">#</th>
                                                    {queryResult.columns.map((col, idx) => (
                                                        <th key={idx} className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider whitespace-nowrap">
                                                            {col}
                                                        </th>
                                                    ))}
                                                </tr>
                                            </thead>
                                            <tbody className="bg-white divide-y divide-gray-200">
                                                {queryResult.rows.map((row, rIdx) => (
                                                    <tr key={rIdx} className="hover:bg-gray-50">
                                                        <td className="px-4 py-2 text-xs text-gray-400 bg-gray-50 border-r border-gray-200">{rIdx + 1}</td>
                                                        {queryResult.columns.map((col, cIdx) => (
                                                            <td key={cIdx} className="px-6 py-4 whitespace-nowrap text-sm text-gray-700">
                                                                {String(row[col] ?? '')}
                                                            </td>
                                                        ))}
                                                    </tr>
                                                ))}
                                            </tbody>
                                        </table>
                                    )}
                                </div>
                            )}

                            {activeTab === 'metadata' && (
                                <div className="p-6">
                                    {queryResult ? (
                                        <div className="space-y-4">
                                            <div>
                                                <div className="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-2">Execution Info</div>
                                                <div className="space-y-2 text-sm">
                                                    <div className="flex justify-between py-2 border-b border-gray-100">
                                                        <span className="text-gray-600">Attempt ID:</span>
                                                        <span className="font-medium text-xs font-mono">{queryResult.attempt_id}</span>
                                                    </div>
                                                    <div className="flex justify-between py-2 border-b border-gray-100">
                                                        <span className="text-gray-600">Row Count:</span>
                                                        <span className="font-medium">{queryResult.row_count}</span>
                                                    </div>
                                                    <div className="flex justify-between py-2 border-b border-gray-100">
                                                        <span className="text-gray-600">Rows Returned:</span>
                                                        <span className="font-medium">{queryResult.rows.length}</span>
                                                    </div>
                                                    <div className="flex justify-between py-2 border-b border-gray-100">
                                                        <span className="text-gray-600">Execution Duration:</span>
                                                        <span className="font-medium">{queryResult.duration_ms} ms</span>
                                                    </div>
                                                    <div className="flex justify-between py-2 border-b border-gray-100">
                                                        <span className="text-gray-600">Confidence:</span>
                                                        <span className="font-medium">{queryResult.confidence ? `${(queryResult.confidence * 100).toFixed(1)}%` : 'N/A'}</span>
                                                    </div>
                                                </div>
                                            </div>
                                        </div>
                                    ) : (
                                        <div className="text-center text-gray-400 py-8">No metadata available</div>
                                    )}
                                </div>
                            )}

                            {activeTab === 'citations' && (
                                <div className="p-6">
                                    <div className="space-y-4">
                                        <div>
                                            <div className="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-2">Schema Objects</div>
                                            <div className="text-sm text-gray-400 italic">Coming soon...</div>
                                        </div>
                                        <div>
                                            <div className="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-2">RAG Documents</div>
                                            <div className="text-sm text-gray-400 italic">Coming soon...</div>
                                        </div>
                                    </div>
                                </div>
                            )}

                            {activeTab === 'query-plan' && (
                                <div className="p-6">
                                    <div className="text-center text-gray-400 py-8">Query plan visualization coming soon...</div>
                                </div>
                            )}
                        </div>
                    </div>

                    {/* BOTTOM: Export Bar */}
                    {queryResult && queryResult.rows.length > 0 && (
                        <div className="border-t border-gray-200 bg-gray-50 px-4 py-3 flex justify-between items-center flex-shrink-0">
                            <div className="flex items-center gap-4">
                                <span className="text-xs font-semibold text-gray-600">Export Format:</span>
                                <select
                                    value={exportFormat}
                                    onChange={(e) => setExportFormat(e.target.value as any)}
                                    className="px-3 py-1.5 text-xs border border-gray-300 rounded focus:outline-none focus:ring-2 focus:ring-blue-500"
                                >
                                    <option value="json">JSON</option>
                                    <option value="csv">CSV</option>
                                    <option value="xlsx">XLSX</option>
                                    <option value="tsv">TSV</option>
                                    <option value="parquet">Parquet</option>
                                </select>

                                <span className="text-xs font-semibold text-gray-600 ml-4">Delivery Mode:</span>
                                <select className="px-3 py-1.5 text-xs border border-gray-300 rounded focus:outline-none focus:ring-2 focus:ring-blue-500">
                                    <option>Download</option>
                                    <option>Email</option>
                                </select>

                                <button
                                    onClick={handleExport}
                                    disabled={isExporting}
                                    className="px-4 py-1.5 text-xs font-medium text-gray-700 bg-white border border-gray-300 rounded hover:bg-gray-50 disabled:opacity-50"
                                >
                                    {isExporting ? 'Exporting...' : 'Download'}
                                </button>
                            </div>

                            <div className="flex items-center gap-3">
                                <button className="flex items-center gap-2 px-4 py-1.5 text-xs font-medium text-white bg-blue-600 rounded hover:bg-blue-700">
                                    <CheckCircle2 size={14} />
                                    Save Query
                                </button>
                                <button className="flex items-center gap-2 px-4 py-1.5 text-xs font-medium text-white bg-blue-600 rounded hover:bg-blue-700">
                                    <Calendar size={14} />
                                    Schedule
                                </button>
                            </div>
                        </div>
                    )}
                </div>
            </div>
        </div>
    );
};
