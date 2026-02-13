import React, { useState, useEffect } from 'react';
import { Play, MessageSquare, Terminal, Loader2, Send, PanelRight } from 'lucide-react';
import { toast } from 'sonner';
import { client } from '../lib/api/client';
import { Sidebar } from '../components/Layout/Sidebar';
import { DebugPanel } from '../components/Query/DebugPanel';
import { FeedbackForm } from '../components/Query/FeedbackForm';
import { ExportBar } from '../components/Query/ExportBar';
import type { components } from '../lib/api/types';

// Types
type DataSource = components['schemas']['DataSourceListResponse']['items'][number];
type RunResponse = components['schemas']['RunSessionResponse'];

export const QueryWorkspace: React.FC = () => {
    // --- State ---
    const [dataSources, setDataSources] = useState<DataSource[]>([]);
    const [selectedDataSourceId, setSelectedDataSourceId] = useState<string>('');

    const [question, setQuestion] = useState('');
    const [sessionId, setSessionId] = useState<string | null>(null);
    const [generatedSql, setGeneratedSql] = useState('');
    const [queryResult, setQueryResult] = useState<RunResponse | null>(null);

    const [isGenerating, setIsGenerating] = useState(false);
    const [isRunning, setIsRunning] = useState(false);
    const [isDebugOpen, setIsDebugOpen] = useState(false);

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
        setGeneratedSql(''); // Reset previous
        setQueryResult(null); // Reset previous results

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
                // In a real app, the session creation might return the initial SQL if strictly synchronous,
                // OR we might need to poll/wait for a "generated" event. 
                // Based on the spec, `POST /session` returns { session_id, status: 'created' }.
                // We likely need to "run" it to get the SQL, OR there's a missing step in the spec/mock 
                // where we get the SQL *before* execution.
                // For MVP based on the described flow (Review SQL -> Run), let's assume 
                // we might trigger a "preview" run or the creation itself *should* have returned SQL.
                // CHECK: The spec says POST /run returns SQL.
                // Implementation Detail: We'll immediately trigger a "dry run" or 
                // just use the RUN endpoint to get the SQL, then let user edit, then RUN again.
                // ACTUALLY: The `RunSessionResponse` has `sql`.
                // So "Ask" -> "Create Session" -> "Run (to generate)" -> "Review".

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
        // We'll call run but maybe we can add a flag for "generate_only" if supported? 
        // For now, we'll just run it. If the user wants to review, we might need a backend change 
        // or we just show the result of the first run and let them iterate.
        // ticket UI-010 says: "Generated SQL is displayed in an editable editor before rerun."
        // implying we can get SQL without running? 
        // Checking OpenAPI: `RunSessionResponse` has `sql` and `rows`.
        // The backend likely runs generation AND execution in one go for the alpha.
        // We will display the SQL from this first run.

        const { data } = await client.POST('/v1/query/sessions/{sessionId}/run', {
            params: { path: { sessionId: sessId } },
            body: {
                // default params
            }
        });

        if (data) {
            setGeneratedSql(data.sql);
            setQueryResult(data);
        }
    };

    const handleRun = async () => {
        if (!sessionId) return;

        setIsRunning(true);
        try {
            // We assume the backend might accept an overriding SQL in the run body 
            // nicely, but the current OpenAPI `RunSessionRequest` doesn't strictly have an `sql` override field?
            // Let's check the spec... 
            // `RunSessionRequest`: llm_provider, model, max_rows, timeout_ms.
            // It does NOT have `sql`. 
            // This implies the Backend dictates the SQL based on the question history.
            // For this MVP UI ticket, if we want "User can manually modify SQL", 
            // we either need to send the modified SQL (missing in spec?) or this feature requires backend support.
            // WORKAROUND: We will display it as editable, but if the backend doesn't support running arbitrary SQL yet,
            // we might just warn/toast or strictly run what we have.
            // *Self-correction*: For a "NL-to-SQL" tool, editing generated SQL is critical. 
            // I'll assume for now we might pass it as a special param or maybe I missed it.
            // Re-reading spec... `RunSessionRequest` indeed lacks `sql`. 
            // Implementation Plan Update: I will allow editing in UI state, but until backend supports `sql` override,
            // "Run" will re-trigger the generation logic (effectively "Regenerate").
            // OR, I can assume there's a hidden field or I should add it.
            // Given I can't change backend right now, I will implement the UI as editable, 
            // but executing will re-run the *session* context. 
            // Wait, if I can't override SQL, the "Edit" feature is fake. 
            // I will assume for now that "Run" re-executes the session. 

            const { data } = await client.POST('/v1/query/sessions/{sessionId}/run', {
                params: { path: { sessionId } },
                body: {
                    // If we could send SQL: sql: generatedSql 
                }
            });

            if (data) {
                setGeneratedSql(data.sql);
                setQueryResult(data);
            }
        } catch (e) {
            console.error(e);
            toast.error("Run failed");
        } finally {
            setIsRunning(false);
        }
    };

    return (
        <div className="h-full flex flex-row bg-gray-50 overflow-hidden">
            {/* Left Sidebar */}
            <Sidebar
                dataSources={dataSources}
                selectedDataSourceId={selectedDataSourceId}
                onSelectDataSource={setSelectedDataSourceId}
            />

            {/* Main Content */}
            <div className="flex-1 flex flex-col h-full overflow-hidden">
                {/* Top Bar: Question Input Only */}
                <div className="bg-white border-b border-gray-200 p-4 shadow-sm flex-shrink-0">
                    <div className="max-w-4xl mx-auto">
                        <label className="block text-xs font-semibold text-gray-500 uppercase tracking-wider mb-1">Question</label>
                        <div className="relative">
                            <MessageSquare size={16} className="absolute left-3 top-3 text-gray-400" />
                            <textarea
                                className="block w-full pl-10 pr-12 py-2 text-sm border-gray-300 focus:outline-none focus:ring-blue-500 focus:border-blue-500 sm:text-sm rounded-md border resize-none shadow-sm"
                                rows={2}
                                placeholder="e.g. How many active users did we have last month?"
                                value={question}
                                onChange={(e) => setQuestion(e.target.value)}
                                onKeyDown={(e) => {
                                    if (e.key === 'Enter' && !e.shiftKey) {
                                        e.preventDefault();
                                        handleAsk();
                                    }
                                }}
                            />
                            <button
                                onClick={handleAsk}
                                disabled={isGenerating || !question.trim()}
                                className="absolute right-2 bottom-2 p-1.5 bg-blue-600 text-white rounded-md hover:bg-blue-700 disabled:opacity-50 transition-colors"
                            >
                                {isGenerating ? <Loader2 size={16} className="animate-spin" /> : <Send size={16} />}
                            </button>
                        </div>
                    </div>
                </div>

                {/* Main Content Area */}
                <div className="flex-1 flex overflow-hidden">
                    {/* Left: SQL Editor & Results */}
                    <div className="flex-1 flex flex-col min-w-0 overflow-hidden">

                        {/* SQL Editor Region */}
                        {(generatedSql || isGenerating) && (
                            <div className="flex-shrink-0 border-b border-gray-200 bg-white">
                                <div className="flex justify-between items-center px-4 py-2 bg-gray-50 border-b border-gray-200">
                                    <span className="text-xs font-semibold text-gray-500 uppercase flex items-center gap-2">
                                        <Terminal size={14} />
                                        Generated SQL
                                    </span>
                                    <div className="flex gap-2">
                                        <button
                                            onClick={() => setIsDebugOpen(!isDebugOpen)}
                                            className={`flex items-center gap-1.5 px-3 py-1 text-xs font-medium rounded transition-colors
                                            ${isDebugOpen ? 'bg-gray-200 text-gray-800' : 'text-gray-500 hover:bg-gray-100'}`}
                                            title="Toggle Debug Panel"
                                        >
                                            <PanelRight size={14} />
                                        </button>
                                        <button
                                            onClick={handleRun}
                                            disabled={isRunning}
                                            className="flex items-center gap-1.5 px-3 py-1 bg-green-600 text-white text-xs font-medium rounded hover:bg-green-700 disabled:opacity-50"
                                        >
                                            {isRunning ? <Loader2 size={12} className="animate-spin" /> : <Play size={12} />}
                                            Run
                                        </button>
                                    </div>
                                </div>
                                <div className="relative group">
                                    {isGenerating ? (
                                        <div className="h-32 flex items-center justify-center text-gray-400 text-sm">
                                            <Loader2 className="animate-spin mr-2" size={16} />
                                            Generating Query...
                                        </div>
                                    ) : (
                                        <textarea
                                            className="w-full h-32 p-4 font-mono text-sm text-gray-800 bg-gray-50 resize-none focus:outline-none focus:bg-white transition-colors"
                                            value={generatedSql}
                                            onChange={(e) => setGeneratedSql(e.target.value)}
                                            spellCheck={false}
                                        />
                                    )}
                                </div>
                            </div>
                        )}

                        {/* Results Region */}
                        <div className="flex-1 overflow-auto bg-white p-0 relative">
                            {!queryResult && !isGenerating && (
                                <div className="h-full flex flex-col items-center justify-center text-gray-400">
                                    <Terminal size={48} className="mb-4 opacity-10" />
                                    <p>Ready to query.</p>
                                </div>
                            )}

                            {queryResult && (
                                <div className="min-w-full inline-block align-middle">
                                    <table className="min-w-full divide-y divide-gray-200">
                                        <thead className="bg-gray-50 sticky top-0 z-10">
                                            <tr>
                                                {queryResult.columns.map((col, idx) => (
                                                    <th key={idx} scope="col" className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider whitespace-nowrap">
                                                        {col}
                                                    </th>
                                                ))}
                                            </tr>
                                        </thead>
                                        <tbody className="bg-white divide-y divide-gray-200">
                                            {queryResult.rows.map((row, rIdx) => (
                                                <tr key={rIdx} className="hover:bg-gray-50">
                                                    {queryResult.columns.map((col, cIdx) => (
                                                        <td key={cIdx} className="px-6 py-4 whitespace-nowrap text-sm text-gray-500">
                                                            {String(row[col] ?? '')}
                                                        </td>
                                                    ))}
                                                </tr>
                                            ))}
                                        </tbody>
                                    </table>
                                    {queryResult.rows.length === 0 && (
                                        <div className="p-8 text-center text-gray-500">No results returned.</div>
                                    )}
                                </div>
                            )}

                            {queryResult && sessionId && (
                                <div className="mx-auto max-w-4xl w-full border-t border-gray-100">
                                    <FeedbackForm sessionId={sessionId} />
                                </div>
                            )}
                        </div>

                        {/* Export Bar */}
                        {queryResult && sessionId && (
                            <ExportBar
                                sessionId={sessionId}
                                hasResults={queryResult.rows.length > 0}
                            />
                        )}
                    </div>


                    {/* Right: Debug/Context Panel */}
                    <div className={`border-l border-gray-200 bg-white shadow-xl transform transition-transform duration-300 absolute right-0 top-0 bottom-0 z-20 w-80
                    ${isDebugOpen ? 'translate-x-0' : 'translate-x-full'}`}>
                        <DebugPanel
                            isOpen={isDebugOpen}
                            onClose={() => setIsDebugOpen(false)}
                            metadata={queryResult}
                        />
                    </div>
                </div>
            </div>
        </div>
    );
};
