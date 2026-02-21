import React, { useState, useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import Editor, { type OnMount } from '@monaco-editor/react';
import {
    Play,
    Copy,
    RotateCcw,
    Eye,
    Loader2,
    CheckCircle2,
    Calendar,
    Send,
    ChevronDown,
    ChevronRight,
    GripHorizontal
} from 'lucide-react';
import type { editor } from 'monaco-editor';
import { format as formatSql } from 'sql-formatter';
import { toast } from 'sonner';
import { client } from '../lib/api/client';
import { Sidebar } from '../components/Layout/Sidebar';
import { useDataSource } from '../hooks/useDataSource';

import type { components } from '../lib/api/types';

// Types
type RunResponse = components['schemas']['RunSessionResponse'];
type PromptHistoryItem = components['schemas']['PromptHistoryItem'];

interface LlmProvider {
    id: string;
    provider: string;
    default_model: string;
    enabled: boolean;
}

const PROVIDER_DISPLAY_NAMES: Record<string, string> = {
    openai: 'OpenAI',
    gemini: 'Google Gemini',
    deepseek: 'DeepSeek',
};

type TabType = 'results' | 'metadata' | 'citations' | 'query-plan';
type ExportFormat = 'json' | 'csv' | 'xlsx' | 'tsv' | 'parquet';
type SectionKey = 'prompt' | 'sql';

const LAYOUT_STORAGE_KEY = 'query-workspace-layout-v1';
const MIN_SECTION_HEIGHT = 120;
const MAX_HEIGHT_RATIO = 0.55;
const DEFAULT_PROMPT_HEIGHT = 220;
const DEFAULT_SQL_HEIGHT = 180;

interface LayoutState {
    promptExpanded: boolean;
    sqlExpanded: boolean;
    promptHeight: number;
    sqlHeight: number;
}

const clampHeight = (value: number) => {
    const maxHeight = Math.max(MIN_SECTION_HEIGHT, Math.floor(window.innerHeight * MAX_HEIGHT_RATIO));
    return Math.max(MIN_SECTION_HEIGHT, Math.min(maxHeight, value));
};

const getInitialLayout = (): LayoutState => {
    const isSmallScreen = typeof window !== 'undefined' && window.matchMedia('(max-width: 768px)').matches;

    const fallback: LayoutState = {
        promptExpanded: true,
        sqlExpanded: !isSmallScreen,
        promptHeight: isSmallScreen ? 190 : DEFAULT_PROMPT_HEIGHT,
        sqlHeight: isSmallScreen ? 150 : DEFAULT_SQL_HEIGHT,
    };

    if (typeof window === 'undefined') return fallback;

    try {
        const raw = window.localStorage.getItem(LAYOUT_STORAGE_KEY);
        if (!raw) return fallback;

        const saved = JSON.parse(raw) as Partial<LayoutState>;
        return {
            promptExpanded: saved.promptExpanded ?? fallback.promptExpanded,
            sqlExpanded: saved.sqlExpanded ?? fallback.sqlExpanded,
            promptHeight: Number.isFinite(saved.promptHeight) ? clampHeight(Number(saved.promptHeight)) : fallback.promptHeight,
            sqlHeight: Number.isFinite(saved.sqlHeight) ? clampHeight(Number(saved.sqlHeight)) : fallback.sqlHeight,
        };
    } catch {
        return fallback;
    }
};

export const QueryWorkspace: React.FC = () => {
    // --- State ---
    const { dataSources, selectedDataSourceId } = useDataSource();

    const [question, setQuestion] = useState('');

    const [sessionId, setSessionId] = useState<string | null>(null);
    const [generatedSql, setGeneratedSql] = useState('');
    const [originalSql, setOriginalSql] = useState(''); // For reset
    const [queryResult, setQueryResult] = useState<RunResponse | null>(null);

    const [isGenerating, setIsGenerating] = useState(false);
    const [isRunning, setIsRunning] = useState(false);
    const [activeTab, setActiveTab] = useState<TabType>('results');

    // Query controls - providers loaded dynamically
    const [llmProviders, setLlmProviders] = useState<LlmProvider[]>([]);
    const [provider, setProvider] = useState('');
    const [model, setModel] = useState('');
    const [maxRows, setMaxRows] = useState(1000);
    const [timeout, setTimeout] = useState(60);
    const [isReadOnly, setIsReadOnly] = useState(false);
    const [promptHistory, setPromptHistory] = useState<PromptHistoryItem[]>([]);
    const [isPromptHistoryOpen, setIsPromptHistoryOpen] = useState(false);
    const [isPromptHistoryLoading, setIsPromptHistoryLoading] = useState(false);
    const [promptHistoryQuery, setPromptHistoryQuery] = useState('');

    // Export controls
    const [exportFormat, setExportFormat] = useState<ExportFormat>('csv');
    const [isExporting, setIsExporting] = useState(false);

    // Layout controls
    const [initialLayout] = useState<LayoutState>(() => getInitialLayout());
    const [isPromptExpanded, setIsPromptExpanded] = useState(initialLayout.promptExpanded);
    const [isSqlExpanded, setIsSqlExpanded] = useState(initialLayout.sqlExpanded);
    const [promptHeight, setPromptHeight] = useState(initialLayout.promptHeight);
    const [sqlHeight, setSqlHeight] = useState(initialLayout.sqlHeight);

    const dragStateRef = useRef<{ section: SectionKey; startY: number; startHeight: number } | null>(null);
    const sqlEditorRef = useRef<editor.IStandaloneCodeEditor | null>(null);
    const promptHistoryRef = useRef<HTMLDivElement | null>(null);
    const promptHistoryButtonRef = useRef<HTMLButtonElement | null>(null);
    const promptHistoryPanelRef = useRef<HTMLDivElement | null>(null);
    const [promptHistoryPosition, setPromptHistoryPosition] = useState<{ top: number; left: number; width: number; panelMaxHeight: number }>({
        top: 0,
        left: 0,
        width: 620,
        panelMaxHeight: 420,
    });

    // --- Effects ---
    useEffect(() => {
        const fetchProviders = async () => {
            const { data } = await client.GET('/v1/llm/providers');
            if (data?.items) {
                const enabled = data.items.filter(p => p.enabled);
                setLlmProviders(enabled);
                if (enabled.length > 0) {
                    setProvider(enabled[0].provider);
                    setModel(enabled[0].default_model);
                }
            }
        };

        fetchProviders();
    }, []);

    useEffect(() => {
        const nextState: LayoutState = {
            promptExpanded: isPromptExpanded,
            sqlExpanded: isSqlExpanded,
            promptHeight,
            sqlHeight,
        };

        window.localStorage.setItem(LAYOUT_STORAGE_KEY, JSON.stringify(nextState));
    }, [isPromptExpanded, isSqlExpanded, promptHeight, sqlHeight]);

    useEffect(() => {
        const handlePointerMove = (event: PointerEvent) => {
            if (!dragStateRef.current) return;

            const { section, startY, startHeight } = dragStateRef.current;
            const nextHeight = clampHeight(startHeight + (event.clientY - startY));

            if (section === 'prompt') {
                setPromptHeight(nextHeight);
                return;
            }

            setSqlHeight(nextHeight);
        };

        const handlePointerUp = () => {
            dragStateRef.current = null;
        };

        window.addEventListener('pointermove', handlePointerMove);
        window.addEventListener('pointerup', handlePointerUp);

        return () => {
            window.removeEventListener('pointermove', handlePointerMove);
            window.removeEventListener('pointerup', handlePointerUp);
        };
    }, []);

    useEffect(() => {
        if (!isPromptHistoryOpen) return;

        const onDocumentClick = (event: MouseEvent) => {
            const target = event.target as Node | null;
            const clickedButtonArea = promptHistoryRef.current && target && promptHistoryRef.current.contains(target);
            const clickedPanelArea = promptHistoryPanelRef.current && target && promptHistoryPanelRef.current.contains(target);
            if (!clickedButtonArea && !clickedPanelArea) {
                setIsPromptHistoryOpen(false);
            }
        };

        const onEscape = (event: KeyboardEvent) => {
            if (event.key === 'Escape') {
                setIsPromptHistoryOpen(false);
            }
        };

        window.addEventListener('mousedown', onDocumentClick);
        window.addEventListener('keydown', onEscape);
        return () => {
            window.removeEventListener('mousedown', onDocumentClick);
            window.removeEventListener('keydown', onEscape);
        };
    }, [isPromptHistoryOpen]);

    useEffect(() => {
        if (!isPromptHistoryOpen) return;

        const updatePosition = () => {
            const button = promptHistoryButtonRef.current;
            if (!button) return;

            const rect = button.getBoundingClientRect();
            const viewportPadding = 16;
            const desiredWidth = Math.min(620, window.innerWidth - viewportPadding * 2);
            const left = Math.max(viewportPadding, Math.min(rect.right - desiredWidth, window.innerWidth - desiredWidth - viewportPadding));

            const spaceBelow = window.innerHeight - rect.bottom - viewportPadding;
            const spaceAbove = rect.top - viewportPadding;
            const showBelow = spaceBelow >= 260 || spaceBelow >= spaceAbove;
            const availableHeight = Math.max(120, Math.floor((showBelow ? spaceBelow : spaceAbove) - 8));
            const panelMaxHeight = Math.min(520, availableHeight);
            const top = showBelow
                ? rect.bottom + 8
                : Math.max(viewportPadding, rect.top - panelMaxHeight - 8);

            setPromptHistoryPosition({ top, left, width: desiredWidth, panelMaxHeight });
        };

        updatePosition();
        window.addEventListener('resize', updatePosition);
        window.addEventListener('scroll', updatePosition, true);

        return () => {
            window.removeEventListener('resize', updatePosition);
            window.removeEventListener('scroll', updatePosition, true);
        };
    }, [isPromptHistoryOpen]);

    useEffect(() => {
        if (!selectedDataSourceId) {
            setPromptHistory([]);
            return;
        }

        void fetchPromptHistory(false);
    }, [selectedDataSourceId]);

    useEffect(() => {
        if (!isPromptHistoryOpen) return;
        if (!selectedDataSourceId) return;

        void fetchPromptHistory(true);
    }, [isPromptHistoryOpen, selectedDataSourceId]);

    const selectedDataSource = dataSources.find((ds) => ds.id === selectedDataSourceId);
    const sqlFormatterDialect: 'postgresql' | 'transactsql' =
        selectedDataSource?.db_type === 'mssql' ? 'transactsql' : 'postgresql';

    // --- Actions ---
    const fetchPromptHistory = async (showLoading = true) => {
        if (showLoading) {
            setIsPromptHistoryLoading(true);
        }
        try {
            const { data } = await client.GET('/v1/query/prompts/history', {
                params: {
                    query: {
                        data_source_id: selectedDataSourceId || undefined,
                        limit: 100,
                    },
                },
            });

            setPromptHistory(data?.items || []);
        } catch (error) {
            console.error(error);
            setPromptHistory([]);
        } finally {
            if (showLoading) {
                setIsPromptHistoryLoading(false);
            }
        }
    };

    const handleAsk = async () => {
        if (!selectedDataSourceId || !question.trim()) return;
        const normalizedQuestion = question.trim();
        const cachedSql = promptHistory.find((item) => item.question.trim() === normalizedQuestion && item.latest_sql)?.latest_sql || null;

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
                toast.error('Failed to generate SQL');
                console.error(error);
            } else if (data) {
                setSessionId(data.session_id);
                await generateSql(data.session_id, cachedSql || undefined);
                void fetchPromptHistory(false);
                if (cachedSql) {
                    toast.success('Used cached SQL from prompt history');
                }
            }
        } catch (err) {
            console.error(err);
            toast.error('An error occurred');
        } finally {
            setIsGenerating(false);
        }
    };

    const generateSql = async (sessId: string, sqlOverride?: string) => {
        const { data } = await client.POST('/v1/query/sessions/{sessionId}/run', {
            params: { path: { sessionId: sessId } },
            body: sqlOverride ? { sql_override: sqlOverride } : {}
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
            toast.error('Run failed');
        } finally {
            setIsRunning(false);
        }
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
        if (!generatedSql.trim()) return;

        const editorInstance = sqlEditorRef.current;
        const model = editorInstance?.getModel();
        if (!editorInstance || !model) {
            toast.error('SQL formatter is not available');
            return;
        }

        try {
            const formatted = formatSql(model.getValue(), { language: sqlFormatterDialect });
            editorInstance.executeEdits('format-sql', [{ range: model.getFullModelRange(), text: formatted }]);
            editorInstance.pushUndoStop();
        } catch (error) {
            console.error('Failed to format SQL:', error);
            toast.error('Failed to format SQL');
        }
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
        } catch (error) {
            const message = error instanceof Error ? error.message : 'Failed to export';
            toast.error(message);
        } finally {
            setIsExporting(false);
        }
    };

    const startResize = (section: SectionKey) => (event: React.PointerEvent<HTMLDivElement>) => {
        if (event.pointerType === 'mouse' && event.button !== 0) return;

        event.preventDefault();
        dragStateRef.current = {
            section,
            startY: event.clientY,
            startHeight: section === 'prompt' ? promptHeight : sqlHeight,
        };
    };

    const filteredPromptHistory = promptHistoryQuery.trim()
        ? promptHistory.filter((item) => item.question.toLowerCase().includes(promptHistoryQuery.trim().toLowerCase()))
        : promptHistory;

    return (
        <div className="h-full flex overflow-hidden">
            {/* Main Workspace */}
            <div className="flex-1 flex flex-col overflow-hidden min-h-0">
                {/* SECTION 1: Prompt Section */}
                <div className="bg-white border-b border-gray-200 flex-shrink-0">
                    <div className="px-4 py-2 bg-gray-50 border-b border-gray-200 flex justify-between items-center">
                        <button
                            type="button"
                            onClick={() => setIsPromptExpanded(prev => !prev)}
                            aria-expanded={isPromptExpanded}
                            aria-controls="query-prompt-section"
                            className="flex items-center gap-1.5 text-xs font-semibold text-gray-700"
                        >
                            {isPromptExpanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                            <span>Prompt section</span>
                        </button>
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

                    {isPromptExpanded && (
                        <div
                            id="query-prompt-section"
                            className="overflow-auto"
                            style={{ height: promptHeight }}
                        >
                            <div className="max-w-6xl mx-auto p-4">
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
                                            onChange={(e) => {
                                                const selected = e.target.value;
                                                setProvider(selected);
                                                const p = llmProviders.find(lp => lp.provider === selected);
                                                if (p) setModel(p.default_model);
                                            }}
                                            className="px-2 py-1 text-xs border border-gray-300 rounded focus:outline-none focus:ring-2 focus:ring-blue-500"
                                        >
                                            {llmProviders.length === 0 && (
                                                <option value="">No providers configured</option>
                                            )}
                                            {llmProviders.map(p => (
                                                <option key={p.provider} value={p.provider}>
                                                    {PROVIDER_DISPLAY_NAMES[p.provider] || p.provider}
                                                </option>
                                            ))}
                                        </select>
                                    </div>

                                    <div className="flex items-center gap-2">
                                        <label className="text-xs font-medium text-gray-600">Model:</label>
                                        <input
                                            type="text"
                                            value={model}
                                            onChange={(e) => setModel(e.target.value)}
                                            className="w-36 px-2 py-1 text-xs border border-gray-300 rounded focus:outline-none focus:ring-2 focus:ring-blue-500"
                                            placeholder="e.g. gpt-4o"
                                        />
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

                                    <div ref={promptHistoryRef} className="ml-auto relative">
                                        <button
                                            ref={promptHistoryButtonRef}
                                            type="button"
                                            onClick={() => setIsPromptHistoryOpen((prev) => !prev)}
                                            className="px-3 py-1.5 text-xs font-medium text-gray-700 bg-white border border-gray-300 rounded hover:bg-gray-50"
                                        >
                                            Prompt History
                                        </button>
                                        {isPromptHistoryOpen && typeof document !== 'undefined' && createPortal(
                                            <div
                                                ref={promptHistoryPanelRef}
                                                className="fixed rounded-xl border border-gray-200 bg-white shadow-2xl z-[200] overflow-hidden flex flex-col"
                                                style={{
                                                    top: promptHistoryPosition.top,
                                                    left: promptHistoryPosition.left,
                                                    width: promptHistoryPosition.width,
                                                    maxHeight: promptHistoryPosition.panelMaxHeight,
                                                }}
                                            >
                                                <div className="px-5 pt-4 pb-3 border-b border-gray-100 bg-gray-50/60">
                                                    <div className="text-sm font-semibold text-gray-800 mb-2">Prompt History</div>
                                                    <input
                                                        type="text"
                                                        value={promptHistoryQuery}
                                                        onChange={(e) => setPromptHistoryQuery(e.target.value)}
                                                        placeholder="Search prompt history..."
                                                        className="w-full px-3 py-2 text-sm border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
                                                    />
                                                </div>
                                                <div className="overflow-auto p-2 min-h-0 flex-1">
                                                    {isPromptHistoryLoading && (
                                                        <div className="px-4 py-10 text-sm text-gray-500 flex items-center justify-center gap-2">
                                                            <Loader2 size={14} className="animate-spin" />
                                                            Loading prompt history...
                                                        </div>
                                                    )}
                                                    {!isPromptHistoryLoading && filteredPromptHistory.length === 0 && (
                                                        <div className="px-4 py-10 text-sm text-gray-500 text-center">
                                                            No prompts found.
                                                        </div>
                                                    )}
                                                    {!isPromptHistoryLoading && filteredPromptHistory.map((item) => (
                                                        <button
                                                            key={item.id}
                                                            type="button"
                                                            onClick={() => {
                                                                setQuestion(item.question);
                                                                if (item.latest_sql) {
                                                                    setGeneratedSql(item.latest_sql);
                                                                    setOriginalSql(item.latest_sql);
                                                                }
                                                                setIsPromptHistoryOpen(false);
                                                            }}
                                                            className="w-full text-left px-4 py-3.5 rounded-lg border border-transparent hover:border-gray-200 hover:bg-gray-50 transition-colors mb-1 last:mb-0"
                                                            title={item.question}
                                                        >
                                                            <div className="text-sm font-medium text-gray-800 line-clamp-2 break-words leading-5">{item.question}</div>
                                                            <div className="mt-2 flex items-center justify-between gap-2 text-xs text-gray-500">
                                                                <span>{new Date(item.created_at).toLocaleString()}</span>
                                                                <span className={`font-medium ${item.latest_sql ? 'text-emerald-700' : 'text-gray-400'}`}>
                                                                    {item.latest_sql ? 'SQL cached' : 'No SQL'}
                                                                </span>
                                                            </div>
                                                        </button>
                                                    ))}
                                                </div>
                                            </div>,
                                            document.body
                                        )}
                                    </div>
                                    <button
                                        onClick={handleAsk}
                                        disabled={isGenerating || !question.trim() || !selectedDataSourceId}
                                        className="flex items-center gap-1.5 px-4 py-1.5 bg-blue-600 text-white text-xs font-medium rounded hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed"
                                    >
                                        {isGenerating ? <Loader2 size={14} className="animate-spin" /> : <Send size={14} />}
                                        Ask
                                    </button>
                                </div>
                            </div>
                        </div>
                    )}
                </div>

                {isPromptExpanded && (
                    <div
                        role="separator"
                        aria-orientation="horizontal"
                        aria-label="Resize prompt section"
                        onPointerDown={startResize('prompt')}
                        className="h-2 bg-gray-100 hover:bg-gray-200 active:bg-gray-300 cursor-row-resize flex items-center justify-center flex-shrink-0 touch-none"
                    >
                        <GripHorizontal size={14} className="text-gray-400" />
                    </div>
                )}

                {/* SECTION 2: SQL Section */}
                <div className="bg-white border-b border-gray-200 flex-shrink-0">
                    <div className="px-4 py-2 bg-gray-50 border-b border-gray-200 flex justify-between items-center">
                        <button
                            type="button"
                            onClick={() => setIsSqlExpanded(prev => !prev)}
                            aria-expanded={isSqlExpanded}
                            aria-controls="query-sql-section"
                            className="flex items-center gap-1.5 text-xs font-semibold text-gray-700"
                        >
                            {isSqlExpanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                            <span>SQL section</span>
                        </button>
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
                            <button
                                onClick={handleFormatSql}
                                className="px-2 py-1 text-xs font-medium text-gray-600 hover:text-gray-800 disabled:opacity-50 disabled:cursor-not-allowed"
                                disabled={!generatedSql || isReadOnly}
                            >
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

                    {isSqlExpanded && (
                        <div
                            id="query-sql-section"
                            className="bg-gray-50 overflow-hidden"
                            style={{ height: sqlHeight }}
                        >
                            {isGenerating ? (
                                <div className="h-full min-h-20 flex items-center justify-center text-gray-400 text-sm">
                                    <Loader2 className="animate-spin mr-2" size={16} />
                                    Generating SQL...
                                </div>
                            ) : generatedSql ? (
                                <div className="h-full flex flex-col">
                                    <div className="px-4 py-1 text-xs text-gray-500 bg-gray-100 border-b border-gray-200">
                                        Generated SQL
                                    </div>
                                    <div className="flex-1 min-h-0">
                                        <Editor
                                            height="100%"
                                            language="sql"
                                            value={generatedSql}
                                            onChange={(value) => setGeneratedSql(value ?? '')}
                                            onMount={handleSqlEditorMount}
                                            options={{
                                                automaticLayout: true,
                                                fontSize: 12,
                                                lineNumbersMinChars: 3,
                                                minimap: { enabled: false },
                                                readOnly: isReadOnly,
                                                scrollBeyondLastLine: false,
                                                tabSize: 2,
                                                wordWrap: 'on',
                                            }}
                                        />
                                    </div>
                                </div>
                            ) : (
                                <div className="h-full min-h-20 flex items-center justify-center text-gray-400 text-sm p-4 text-center">
                                    Enter a question and press Enter or click Ask to generate SQL
                                </div>
                            )}
                        </div>
                    )}
                </div>

                {isSqlExpanded && (
                    <div
                        role="separator"
                        aria-orientation="horizontal"
                        aria-label="Resize SQL section"
                        onPointerDown={startResize('sql')}
                        className="h-2 bg-gray-100 hover:bg-gray-200 active:bg-gray-300 cursor-row-resize flex items-center justify-center flex-shrink-0 touch-none"
                    >
                        <GripHorizontal size={14} className="text-gray-400" />
                    </div>
                )}

                {/* SECTION 3: Result Section */}
                <div className="flex-1 min-h-[220px] flex flex-col overflow-hidden bg-white">
                    {/* Tab Navigation */}
                    <div className="border-b border-gray-200 flex items-center px-4 overflow-x-auto">
                        <div className="text-xs font-semibold text-gray-700 py-2 mr-4 whitespace-nowrap">Result section</div>
                        <div className="flex gap-4">
                            {(['results', 'metadata', 'citations', 'query-plan'] as TabType[]).map(tab => (
                                <button
                                    key={tab}
                                    onClick={() => setActiveTab(tab)}
                                    className={`px-3 py-2 text-xs font-medium border-b-2 transition-colors whitespace-nowrap ${
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
                        <div className="flex items-center gap-4 flex-wrap">
                            <span className="text-xs font-semibold text-gray-600">Export Format:</span>
                            <select
                                value={exportFormat}
                                onChange={(e) => setExportFormat(e.target.value as ExportFormat)}
                                className="px-3 py-1.5 text-xs border border-gray-300 rounded focus:outline-none focus:ring-2 focus:ring-blue-500"
                            >
                                <option value="json">JSON</option>
                                <option value="csv">CSV</option>
                                <option value="xlsx">XLSX</option>
                                <option value="tsv">TSV</option>
                                <option value="parquet">Parquet</option>
                            </select>

                            <span className="text-xs font-semibold text-gray-600">Delivery Mode:</span>
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

            {/* Right Sidebar - Saved Reports */}
            <Sidebar />
        </div>
    );
};
