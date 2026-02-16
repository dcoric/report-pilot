import React from 'react';
import { BookOpen, Clock, Database, ChevronRight } from 'lucide-react';

interface DebugPanelProps {
    isOpen: boolean;
    onClose: () => void;
    metadata: DebugMetadata | null;
}

interface RagDocument {
    source?: string;
    content?: string;
    score?: number;
}

interface DebugMetadata {
    duration_ms?: number;
    row_count?: number;
    confidence?: number;
    rag_documents?: RagDocument[];
}

export const DebugPanel: React.FC<DebugPanelProps> = ({ isOpen, onClose, metadata }) => {
    if (!isOpen) return null;

    return (
        <div className="w-80 border-l border-gray-200 bg-white shadow-xl flex flex-col h-full absolute right-0 top-0 bottom-0 z-20">
            <div className="p-4 border-b border-gray-200 flex justify-between items-center bg-gray-50">
                <h3 className="text-sm font-semibold text-gray-700 flex items-center gap-2">
                    <BookOpen size={16} />
                    Context & Debug
                </h3>
                <button onClick={onClose} className="text-gray-400 hover:text-gray-600">
                    <ChevronRight size={20} />
                </button>
            </div>

            <div className="flex-1 overflow-y-auto p-4 space-y-6">
                {/* Metadata Stats */}
                <div>
                    <h4 className="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-2 flex items-center gap-1">
                        <Clock size={12} /> Execution Stats
                    </h4>
                    <div className="bg-gray-50 rounded p-3 text-sm space-y-1">
                        <div className="flex justify-between">
                            <span className="text-gray-500">Duration:</span>
                            <span className="font-mono text-gray-900">{metadata?.duration_ms}ms</span>
                        </div>
                        <div className="flex justify-between">
                            <span className="text-gray-500">Rows:</span>
                            <span className="font-mono text-gray-900">{metadata?.row_count}</span>
                        </div>
                        <div className="flex justify-between">
                            <span className="text-gray-500">Confidence:</span>
                            <span className="font-mono text-gray-900">
                                {typeof metadata?.confidence === 'number'
                                    ? `${(metadata.confidence * 100).toFixed(1)}%`
                                    : '-'}
                            </span>
                        </div>
                    </div>
                </div>

                {/* RAG Documents (Placeholder if not yet in API response) */}
                {/* Assuming metadata might contain a 'citations' or 'rag_context' field in future */}
                <div>
                    <h4 className="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-2 flex items-center gap-1">
                        <Database size={12} /> Retrieved Context
                    </h4>
                    {metadata?.rag_documents ? (
                        <ul className="space-y-2">
                            {metadata.rag_documents.map((doc: RagDocument, idx: number) => (
                                <li key={idx} className="bg-blue-50 p-2 rounded border border-blue-100 text-xs">
                                    <div className="font-medium text-blue-800 mb-1 truncate">{doc.source || 'Unknown Source'}</div>
                                    <p className="text-gray-600 line-clamp-3">{doc.content}</p>
                                    <div className="mt-1 text-blue-400 text-[10px] text-right">
                                        Score: {typeof doc.score === 'number' ? doc.score.toFixed(3) : '-'}
                                    </div>
                                </li>
                            ))}
                        </ul>
                    ) : (
                        <div className="text-sm text-gray-400 italic bg-gray-50 p-3 rounded text-center">
                            No RAG context available.
                        </div>
                    )}
                </div>
            </div>
        </div>
    );
};
