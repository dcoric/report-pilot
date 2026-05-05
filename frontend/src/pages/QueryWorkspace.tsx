import { useEffect, useRef, useState } from 'react';
import type { editor } from 'monaco-editor';
import type { OnMount } from '@monaco-editor/react';
import { Calendar, CheckCircle2 } from 'lucide-react';
import { format as formatSql } from 'sql-formatter';
import { toast } from 'sonner';
import { Sidebar } from '../components/Layout/Sidebar';
import { PromptSection } from '../components/Query/PromptSection';
import { ResultSection } from '../components/Query/ResultSection';
import { SqlSection } from '../components/Query/SqlSection';
import type { ExportFormat, LlmProvider, PromptHistoryItem, RunResponse, RunProvider, SavedQuery, TabType } from '../components/Query/types';
import { useDataSource } from '../hooks/useDataSource';
import { usePromptHistory } from '../hooks/usePromptHistory';
import { useQueryWorkspaceLayout } from '../hooks/useQueryWorkspaceLayout';
import { client } from '../lib/api/client';

type QueryRunErrorPayload = {
    error?: string;
    message?: string;
    details?: string[];
    sql?: string;
};

function parseRunErrorPayload(error: unknown): QueryRunErrorPayload | null {
    if (!error || typeof error !== 'object') {
        return null;
    }

    const payload = error as Record<string, unknown>;
    const details = Array.isArray(payload.details)
        ? payload.details.map((item) => String(item)).filter(Boolean)
        : undefined;

    return {
        error: typeof payload.error === 'string' ? payload.error : undefined,
        message: typeof payload.message === 'string' ? payload.message : undefined,
        details,
        sql: typeof payload.sql === 'string' ? payload.sql : undefined,
    };
}

export const QueryWorkspace = () => {
    const { dataSources, selectedDataSourceId, setSelectedDataSourceId } = useDataSource();
    const {
        isPromptExpanded,
        setIsPromptExpanded,
        isSqlExpanded,
        setIsSqlExpanded,
        promptHeight,
        sqlHeight,
        startResize,
    } = useQueryWorkspaceLayout();
    const {
        promptHistory,
        filteredPromptHistory,
        isPromptHistoryOpen,
        setIsPromptHistoryOpen,
        isPromptHistoryLoading,
        promptHistoryQuery,
        setPromptHistoryQuery,
        promptHistoryPosition,
        promptHistoryRef,
        promptHistoryButtonRef,
        promptHistoryPanelRef,
        fetchPromptHistory,
    } = usePromptHistory(selectedDataSourceId);

    const [question, setQuestion] = useState('');
    const [sessionId, setSessionId] = useState<string | null>(null);
    const [generatedSql, setGeneratedSql] = useState('');
    const [originalSql, setOriginalSql] = useState('');
    const [queryResult, setQueryResult] = useState<RunResponse | null>(null);
    const [isGenerating, setIsGenerating] = useState(false);
    const [isRunning, setIsRunning] = useState(false);
    const [activeTab, setActiveTab] = useState<TabType>('results');
    const [llmProviders, setLlmProviders] = useState<LlmProvider[]>([]);
    const [provider, setProvider] = useState('');
    const [model, setModel] = useState('');
    const [maxRows, setMaxRows] = useState(1000);
    const [timeout, setTimeout] = useState(60);
    const [isDryRun, setIsDryRun] = useState(false);
    const [exportFormat, setExportFormat] = useState<ExportFormat>('csv');
    const [isExporting, setIsExporting] = useState(false);
    const [loadedSavedQueryId, setLoadedSavedQueryId] = useState<string | null>(null);

    const sqlEditorRef = useRef<editor.IStandaloneCodeEditor | null>(null);
    const selectedDataSource = dataSources.find((dataSource) => dataSource.id === selectedDataSourceId);
    const sqlFormatterDialect: 'postgresql' | 'transactsql' =
        selectedDataSource?.db_type === 'mssql' ? 'transactsql' : 'postgresql';

    const isValidProvider = (value: string): value is RunProvider => (
        llmProviders.some((entry) => entry.provider === value)
    );

    useEffect(() => {
        const fetchProviders = async () => {
            const { data } = await client.GET('/v1/llm/providers');
            if (!data?.items) {
                return;
            }

            const enabledProviders = data.items.filter((entry) => entry.enabled) as LlmProvider[];
            setLlmProviders(enabledProviders);
            setProvider((currentProvider) => (
                enabledProviders.some((entry) => entry.provider === currentProvider)
                    ? currentProvider
                    : enabledProviders[0]?.provider || ''
            ));
            setModel((currentModel) => currentModel || enabledProviders[0]?.default_model || '');
        };

        void fetchProviders();
    }, []);

    useEffect(() => {
        const matchedProvider = llmProviders.find((entry) => entry.provider === provider);
        if (!matchedProvider) {
            return;
        }

        setModel((currentModel) => currentModel || matchedProvider.default_model);
    }, [llmProviders, provider]);

    const applyRunError = (error: unknown, options?: { updateOriginalSql?: boolean }) => {
        const payload = parseRunErrorPayload(error);
        if (!payload?.sql) {
            return;
        }

        setGeneratedSql(payload.sql);
        setIsSqlExpanded(true);
        if (options?.updateOriginalSql) {
            setOriginalSql(payload.sql);
        }
    };

    const generateSql = async (nextSessionId: string, sqlOverride?: string) => {
        const { data, error } = await client.POST('/v1/query/sessions/{sessionId}/run', {
            params: { path: { sessionId: nextSessionId } },
            body: {
                llm_provider: isValidProvider(provider) ? provider : undefined,
                model: model || undefined,
                no_execute: isDryRun || undefined,
                max_rows: maxRows,
                timeout_ms: Math.max(1000, Math.round(timeout * 1000)),
                ...(sqlOverride ? { sql_override: sqlOverride } : {}),
            },
        });

        if (data) {
            setGeneratedSql(data.sql);
            setOriginalSql(data.sql);
            setQueryResult(data as RunResponse);
            setActiveTab(data.preview ? 'metadata' : 'results');
            return;
        }

        if (error) {
            setQueryResult(null);
            applyRunError(error, { updateOriginalSql: true });
        }
    };

    const handleAsk = async () => {
        if (!selectedDataSourceId || !question.trim()) {
            return;
        }

        const normalizedQuestion = question.trim();
        const cachedSql = promptHistory.find((item) => item.question.trim() === normalizedQuestion && item.latest_sql)?.latest_sql || null;

        setIsGenerating(true);
        setGeneratedSql('');
        setQueryResult(null);
        setLoadedSavedQueryId(null);

        try {
            const { data, error } = await client.POST('/v1/query/sessions', {
                body: {
                    data_source_id: selectedDataSourceId,
                    question,
                },
            });

            if (error) {
                toast.error('Failed to generate SQL');
                console.error(error);
                return;
            }

            if (!data) {
                return;
            }

            setSessionId(data.session_id);
            await generateSql(data.session_id, cachedSql || undefined);
            void fetchPromptHistory(false);
            if (cachedSql) {
                toast.success('Used cached SQL from prompt history');
            }
        } catch (error) {
            console.error(error);
            toast.error('An error occurred');
        } finally {
            setIsGenerating(false);
        }
    };

    const handleRun = async () => {
        const sqlOverride = generatedSql.trim();
        if (!sqlOverride) {
            return;
        }

        if (!selectedDataSourceId) {
            toast.error('Select a data source before running SQL.');
            return;
        }

        setIsRunning(true);
        try {
            let nextSessionId = sessionId;
            if (!nextSessionId) {
                const { data: sessionData, error: sessionError } = await client.POST('/v1/query/sessions', {
                    body: {
                        data_source_id: selectedDataSourceId,
                        question: question.trim() || 'Loaded saved query',
                    },
                });

                if (sessionError || !sessionData) {
                    toast.error('Failed to create query session.');
                    return;
                }

                nextSessionId = sessionData.session_id;
                setSessionId(sessionData.session_id);
            }

            const { data, error } = await client.POST('/v1/query/sessions/{sessionId}/run', {
                params: { path: { sessionId: nextSessionId } },
                body: {
                    llm_provider: isValidProvider(provider) ? provider : undefined,
                    model: model || undefined,
                    sql_override: sqlOverride,
                    no_execute: isDryRun || undefined,
                    max_rows: maxRows,
                    timeout_ms: Math.max(1000, Math.round(timeout * 1000)),
                },
            });

            if (data) {
                setGeneratedSql(data.sql);
                setOriginalSql(data.sql);
                setQueryResult(data as RunResponse);
                setActiveTab(data.preview ? 'metadata' : 'results');
                toast.success(data.preview ? 'Preview generated successfully' : 'Query executed successfully');
                return;
            }

            if (error) {
                setQueryResult(null);
                applyRunError(error);
            }
        } catch (error) {
            console.error(error);
            toast.error('Run failed');
        } finally {
            setIsRunning(false);
        }
    };

    const handleLoadSavedQuery = (savedQuery: SavedQuery) => {
        const defaultRunParams = savedQuery.default_run_params;
        const providerConfig = defaultRunParams.llm_provider
            ? llmProviders.find((entry) => entry.provider === defaultRunParams.llm_provider)
            : undefined;

        setSelectedDataSourceId(savedQuery.data_source_id);
        setQuestion('');
        setSessionId(null);
        setGeneratedSql(savedQuery.sql);
        setOriginalSql(savedQuery.sql);
        setQueryResult(null);
        setActiveTab('results');
        setLoadedSavedQueryId(savedQuery.id);
        setIsSqlExpanded(true);

        if (typeof defaultRunParams.max_rows === 'number') {
            setMaxRows(defaultRunParams.max_rows);
        }
        if (typeof defaultRunParams.timeout_ms === 'number') {
            setTimeout(Math.max(1, Math.round(defaultRunParams.timeout_ms / 1000)));
        }
        if (typeof defaultRunParams.no_execute === 'boolean') {
            setIsDryRun(defaultRunParams.no_execute);
        }
        if (defaultRunParams.llm_provider) {
            setProvider(defaultRunParams.llm_provider);
        }
        if (providerConfig) {
            setModel(defaultRunParams.model || providerConfig.default_model);
        } else if (defaultRunParams.model) {
            setModel(defaultRunParams.model);
        }

        toast.success(`Loaded "${savedQuery.name}"`);
    };

    const handleCopy = async () => {
        try {
            await navigator.clipboard.writeText(generatedSql);
            toast.success('SQL copied to clipboard');
        } catch {
            toast.error('Failed to copy');
        }
    };

    const handleReset = () => {
        setGeneratedSql(originalSql);
        toast.info('SQL reset to original');
    };

    const handleSqlEditorMount: OnMount = (editorInstance) => {
        sqlEditorRef.current = editorInstance;
    };

    const handleFormatSql = () => {
        if (!generatedSql.trim()) {
            return;
        }

        const editorInstance = sqlEditorRef.current;
        const modelInstance = editorInstance?.getModel();
        if (!editorInstance || !modelInstance) {
            toast.error('SQL formatter is not available');
            return;
        }

        try {
            const formatted = formatSql(modelInstance.getValue(), { language: sqlFormatterDialect });
            editorInstance.executeEdits('format-sql', [{ range: modelInstance.getFullModelRange(), text: formatted }]);
            editorInstance.pushUndoStop();
        } catch (error) {
            console.error('Failed to format SQL:', error);
            toast.error('Failed to format SQL');
        }
    };

    const handleExport = async () => {
        if (!sessionId || !queryResult?.rows.length) {
            return;
        }

        setIsExporting(true);
        try {
            const response = await fetch(`/v1/query/sessions/${sessionId}/export`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ format: exportFormat }),
            });

            if (!response.ok) {
                throw new Error('Export failed');
            }

            const blob = await response.blob();
            const url = window.URL.createObjectURL(blob);
            const anchor = document.createElement('a');
            anchor.href = url;

            const disposition = response.headers.get('Content-Disposition');
            let filename = `export-${sessionId}.${exportFormat}`;
            if (disposition && disposition.indexOf('filename=') !== -1) {
                const matches = /filename="([^"]*)"/.exec(disposition);
                if (matches && matches[1]) {
                    filename = matches[1];
                }
            }

            anchor.download = filename;
            document.body.appendChild(anchor);
            anchor.click();
            window.URL.revokeObjectURL(url);
            document.body.removeChild(anchor);

            toast.success(`Exported as ${exportFormat.toUpperCase()}`);
        } catch (error) {
            const message = error instanceof Error ? error.message : 'Failed to export';
            toast.error(message);
        } finally {
            setIsExporting(false);
        }
    };

    const handlePromptHistorySelect = (item: PromptHistoryItem) => {
        setQuestion(item.question);
        if (item.latest_sql) {
            setGeneratedSql(item.latest_sql);
            setOriginalSql(item.latest_sql);
            setIsSqlExpanded(true);
        }
        setIsPromptHistoryOpen(false);
    };

    return (
        <div className="flex h-full overflow-hidden">
            <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
                <PromptSection
                    isExpanded={isPromptExpanded}
                    height={promptHeight}
                    isDryRun={isDryRun}
                    question={question}
                    llmProviders={llmProviders}
                    provider={provider}
                    model={model}
                    maxRows={maxRows}
                    timeout={timeout}
                    isGenerating={isGenerating}
                    selectedDataSourceId={selectedDataSourceId}
                    isPromptHistoryOpen={isPromptHistoryOpen}
                    isPromptHistoryLoading={isPromptHistoryLoading}
                    promptHistoryQuery={promptHistoryQuery}
                    filteredPromptHistory={filteredPromptHistory}
                    promptHistoryPosition={promptHistoryPosition}
                    promptHistoryRef={promptHistoryRef}
                    promptHistoryButtonRef={promptHistoryButtonRef}
                    promptHistoryPanelRef={promptHistoryPanelRef}
                    onToggle={() => setIsPromptExpanded((previous) => !previous)}
                    onDryRunChange={setIsDryRun}
                    onQuestionChange={setQuestion}
                    onProviderChange={setProvider}
                    onModelChange={setModel}
                    onMaxRowsChange={setMaxRows}
                    onTimeoutChange={setTimeout}
                    onPromptHistoryToggle={() => setIsPromptHistoryOpen((previous) => !previous)}
                    onPromptHistoryQueryChange={setPromptHistoryQuery}
                    onPromptHistorySelect={handlePromptHistorySelect}
                    onAsk={handleAsk}
                    onResizeStart={startResize('prompt')}
                />

                <SqlSection
                    isExpanded={isSqlExpanded}
                    height={sqlHeight}
                    generatedSql={generatedSql}
                    isGenerating={isGenerating}
                    isRunning={isRunning}
                    isDryRun={isDryRun}
                    canRun={Boolean(generatedSql.trim() && selectedDataSourceId)}
                    onToggle={() => setIsSqlExpanded((previous) => !previous)}
                    onCopy={handleCopy}
                    onReset={handleReset}
                    onFormat={handleFormatSql}
                    onRun={handleRun}
                    onSqlChange={setGeneratedSql}
                    onEditorMount={handleSqlEditorMount}
                    onResizeStart={startResize('sql')}
                />

                <ResultSection
                    activeTab={activeTab}
                    queryResult={queryResult}
                    isRunning={isRunning}
                    isDryRun={isDryRun}
                    onTabChange={setActiveTab}
                />

                {queryResult && queryResult.rows.length > 0 && (
                    <div className="flex flex-shrink-0 items-center justify-between border-t border-gray-200 bg-gray-50 px-4 py-3">
                        <div className="flex flex-wrap items-center gap-4">
                            <span className="text-xs font-semibold text-gray-600">Export Format:</span>
                            <select
                                value={exportFormat}
                                onChange={(event) => setExportFormat(event.target.value as ExportFormat)}
                                className="rounded border border-gray-300 px-3 py-1.5 text-xs focus:ring-2 focus:ring-blue-500 focus:outline-none"
                            >
                                <option value="json">JSON</option>
                                <option value="csv">CSV</option>
                                <option value="xlsx">XLSX</option>
                                <option value="tsv">TSV</option>
                                <option value="parquet">Parquet</option>
                            </select>

                            <span className="text-xs font-semibold text-gray-600">Delivery Mode:</span>
                            <select className="rounded border border-gray-300 px-3 py-1.5 text-xs focus:ring-2 focus:ring-blue-500 focus:outline-none">
                                <option>Download</option>
                                <option>Email</option>
                            </select>

                            <button
                                onClick={handleExport}
                                disabled={isExporting}
                                className="rounded border border-gray-300 bg-white px-4 py-1.5 text-xs font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-50"
                            >
                                {isExporting ? 'Exporting...' : 'Download'}
                            </button>
                        </div>

                        <div className="flex items-center gap-3">
                            <button className="flex items-center gap-2 rounded bg-blue-600 px-4 py-1.5 text-xs font-medium text-white hover:bg-blue-700">
                                <CheckCircle2 size={14} />
                                Save Query
                            </button>
                            <button className="flex items-center gap-2 rounded bg-blue-600 px-4 py-1.5 text-xs font-medium text-white hover:bg-blue-700">
                                <Calendar size={14} />
                                Schedule
                            </button>
                        </div>
                    </div>
                )}
            </div>

            <Sidebar
                dataSources={dataSources}
                selectedDataSourceId={selectedDataSourceId}
                loadedSavedQueryId={loadedSavedQueryId}
                onLoadSavedQuery={handleLoadSavedQuery}
                onLoadedSavedQueryDeleted={(savedQueryId) => {
                    if (loadedSavedQueryId === savedQueryId) {
                        setLoadedSavedQueryId(null);
                    }
                }}
            />
        </div>
    );
};
