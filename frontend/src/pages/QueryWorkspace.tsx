import { useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import type { editor } from 'monaco-editor';
import type { OnMount } from '@monaco-editor/react';
import { Calendar, Loader2, Play, Save, Share2, Timer } from 'lucide-react';
import { format as formatSql } from 'sql-formatter';
import { toast } from 'sonner';
import { InspectorPanel } from '../components/Query/InspectorPanel';
import { PromptSection } from '../components/Query/PromptSection';
import { ResultSection } from '../components/Query/ResultSection';
import { SaveQueryDialog, type SaveQueryDialogValues } from '../components/Query/SaveQueryDialog';
import { SqlSection } from '../components/Query/SqlSection';
import type {
    LlmProvider,
    PromptHistoryItem,
    RunResponse,
    RunProvider,
    SavedQuery,
} from '../components/Query/types';
import { useDataSource } from '../hooks/useDataSource';
import { usePromptHistory } from '../hooks/usePromptHistory';
import { useSavedQueries } from '../hooks/useSavedQueries';
import { useWorkspaceActions } from '../contexts/useWorkspaceActions';
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
    const [searchParams, setSearchParams] = useSearchParams();
    const { dataSources, selectedDataSourceId, setSelectedDataSourceId } = useDataSource();
    const { savedQueries, createSavedQuery, updateSavedQuery } = useSavedQueries();
    const { setActions } = useWorkspaceActions();

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
    const [llmProviders, setLlmProviders] = useState<LlmProvider[]>([]);
    const [provider, setProvider] = useState('');
    const [model, setModel] = useState('');
    const [maxRows, setMaxRows] = useState(1000);
    const [timeout, setTimeout] = useState(60);
    const [isDryRun, setIsDryRun] = useState(false);
    const [loadedSavedQuery, setLoadedSavedQuery] = useState<SavedQuery | null>(null);
    const [saveDialogOpen, setSaveDialogOpen] = useState(false);
    const [isSubmittingSave, setIsSubmittingSave] = useState(false);

    const sqlEditorRef = useRef<editor.IStandaloneCodeEditor | null>(null);
    const selectedDataSource = dataSources.find((dataSource) => dataSource.id === selectedDataSourceId) || null;
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
        setLoadedSavedQuery(null);

        try {
            const { data, error } = await client.POST('/v1/query/sessions', {
                body: { data_source_id: selectedDataSourceId, question },
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

    const loadSavedQuery = (savedQuery: SavedQuery) => {
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
        setLoadedSavedQuery(savedQuery);

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
    };

    // Deep-link: load saved query from ?savedQueryId=
    useEffect(() => {
        const id = searchParams.get('savedQueryId');
        if (!id) {
            return;
        }
        if (loadedSavedQuery?.id === id) {
            return;
        }
        const match = savedQueries.find((entry) => entry.id === id);
        if (match) {
            loadSavedQuery(match);
        }
        // intentionally narrow deps to id+list to load once per id
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [searchParams, savedQueries]);

    // Keep the AppShell's Execute button and breadcrumb in sync.
    useEffect(() => {
        const breadcrumb = loadedSavedQuery?.name ?? (selectedDataSource?.name ? 'New Query' : 'Query Workspace');
        setActions({
            onExecute: handleRun,
            isExecuting: isRunning,
            canExecute: Boolean(generatedSql.trim() && selectedDataSourceId),
            breadcrumb,
        });
        return () => setActions({});
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [loadedSavedQuery, selectedDataSource, isRunning, generatedSql, selectedDataSourceId]);

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

    const handlePromptHistorySelect = (item: PromptHistoryItem) => {
        setQuestion(item.question);
        if (item.latest_sql) {
            setGeneratedSql(item.latest_sql);
            setOriginalSql(item.latest_sql);
        }
        setIsPromptHistoryOpen(false);
    };

    const handleSaveDialogSubmit = async (values: SaveQueryDialogValues) => {
        if (!selectedDataSourceId) {
            toast.error('Select a data source before saving.');
            return;
        }
        if (!generatedSql.trim()) {
            toast.error('Generate SQL before saving.');
            return;
        }

        const defaultRunParams = {
            llm_provider: isValidProvider(provider) ? provider : undefined,
            model: model || undefined,
            max_rows: maxRows,
            timeout_ms: Math.max(1000, Math.round(timeout * 1000)),
            no_execute: isDryRun,
        };

        setIsSubmittingSave(true);
        try {
            if (loadedSavedQuery) {
                const updated = await updateSavedQuery(loadedSavedQuery.id, {
                    name: values.name,
                    description: values.description,
                    dataSourceId: selectedDataSourceId,
                    sql: generatedSql,
                    defaultRunParams,
                    parameterSchema: loadedSavedQuery.parameter_schema,
                    tags: values.tags,
                });
                if (updated) {
                    setLoadedSavedQuery(updated);
                    toast.success('Saved query updated.');
                    setSaveDialogOpen(false);
                }
            } else {
                const created = await createSavedQuery({
                    name: values.name,
                    description: values.description,
                    dataSourceId: selectedDataSourceId,
                    sql: generatedSql,
                    defaultRunParams,
                    tags: values.tags,
                });
                if (created) {
                    setLoadedSavedQuery(created);
                    toast.success('Query saved.');
                    setSaveDialogOpen(false);
                    setSearchParams({ savedQueryId: created.id }, { replace: true });
                }
            }
        } finally {
            setIsSubmittingSave(false);
        }
    };

    const lastDuration = queryResult && !queryResult.preview ? `${queryResult.duration_ms}ms` : '—';

    return (
        <div className="flex h-full overflow-hidden">
            <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
                <div className="flex h-12 shrink-0 items-center justify-between border-b border-outline-variant bg-white px-4">
                    <div className="flex items-center gap-2">
                        <button
                            type="button"
                            onClick={handleRun}
                            disabled={isRunning || !generatedSql.trim() || !selectedDataSourceId}
                            className="flex items-center gap-2 rounded border border-oxblood px-3 py-1.5 text-xs font-bold text-oxblood transition-colors hover:bg-oxblood/5 disabled:cursor-not-allowed disabled:opacity-50"
                        >
                            {isRunning ? <Loader2 size={12} className="animate-spin" /> : <Play size={12} className="fill-oxblood" />}
                            Run Query
                        </button>
                        <button
                            type="button"
                            onClick={() => setSaveDialogOpen(true)}
                            disabled={!generatedSql.trim() || !selectedDataSourceId}
                            className="flex items-center gap-2 rounded border border-outline-variant px-3 py-1.5 text-xs font-medium text-slate-600 transition-colors hover:bg-surface-container-low disabled:cursor-not-allowed disabled:opacity-50"
                        >
                            <Save size={12} />
                            Save
                        </button>
                        <div className="mx-1 h-4 w-px bg-outline-variant" />
                        <button
                            type="button"
                            disabled
                            className="rounded p-1.5 text-slate-400"
                            title="Share — coming soon"
                            aria-label="Share"
                        >
                            <Share2 size={16} />
                        </button>
                        <button
                            type="button"
                            disabled
                            className="rounded p-1.5 text-slate-400"
                            title="Schedule — coming soon"
                            aria-label="Schedule"
                        >
                            <Calendar size={16} />
                        </button>
                    </div>
                    <div className="flex items-center gap-4 text-[11px] font-medium text-slate-500">
                        <div className="flex items-center gap-1.5">
                            <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" />
                            {selectedDataSource ? 'Connected' : 'Disconnected'}
                        </div>
                        <div className="flex items-center gap-1.5">
                            <Timer size={12} />
                            {lastDuration}
                        </div>
                    </div>
                </div>

                <PromptSection
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
                />

                <SqlSection
                    generatedSql={generatedSql}
                    isGenerating={isGenerating}
                    onCopy={handleCopy}
                    onReset={handleReset}
                    onFormat={handleFormatSql}
                    onSqlChange={setGeneratedSql}
                    onEditorMount={handleSqlEditorMount}
                />

                <ResultSection
                    queryResult={queryResult}
                    isRunning={isRunning}
                    isDryRun={isDryRun}
                />
            </div>

            <InspectorPanel
                loadedSavedQuery={loadedSavedQuery}
                selectedDataSource={selectedDataSource}
                queryResult={queryResult}
                isDryRun={isDryRun}
            />

            <SaveQueryDialog
                key={loadedSavedQuery?.id ?? 'new'}
                isOpen={saveDialogOpen}
                mode={loadedSavedQuery ? 'edit' : 'create'}
                initial={loadedSavedQuery}
                isSubmitting={isSubmittingSave}
                onClose={() => setSaveDialogOpen(false)}
                onSave={handleSaveDialogSubmit}
                headerHint={selectedDataSource ? `Saving against ${selectedDataSource.name}` : undefined}
            />
        </div>
    );
};
