
import React, { useState } from 'react';
import { Download, Loader2 } from 'lucide-react';
import { toast } from 'sonner';

interface ExportBarProps {
    sessionId: string;
    hasResults: boolean;
}

type ExportFormat = 'json' | 'csv' | 'xlsx';

export const ExportBar: React.FC<ExportBarProps> = ({ sessionId, hasResults }) => {
    const [format, setFormat] = useState<ExportFormat>('csv');
    const [isExporting, setIsExporting] = useState(false);

    const handleExport = async () => {
        if (!sessionId || !hasResults) return;

        setIsExporting(true);
        try {
            // We need to use native fetch because openapi-fetch might try to parse JSON response
            // and we expect a blob.
            // Construct URL manually or use client.baseUrl if available, but here we assume relative path /v1/...
            // Since vite proxy is likely set up, /v1/... works.

            const response = await fetch(`/v1/query/sessions/${sessionId}/export`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({ format })
            });

            if (!response.ok) {
                const errorText = await response.text();
                throw new Error(errorText || 'Export failed');
            }

            const blob = await response.blob();
            const url = window.URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;

            // Try to get filename from Content-Disposition header
            const disposition = response.headers.get('Content-Disposition');
            let filename = `export-${sessionId}.${format}`;
            if (disposition && disposition.indexOf('filename=') !== -1) {
                const matches = /filename="([^"]*)"/.exec(disposition);
                if (matches && matches[1]) {
                    filename = matches[1];
                }
            }

            a.download = filename;
            document.body.appendChild(a);
            a.click();
            window.URL.revokeObjectURL(url);
            document.body.removeChild(a);

            toast.success(`Exported as ${format.toUpperCase()}`);
        } catch (error) {
            console.error('Export error:', error);
            const message = error instanceof Error ? error.message : 'Failed to export results';
            toast.error(message);
        } finally {
            setIsExporting(false);
        }
    };

    if (!hasResults) return null;

    return (
        <div className="border-t border-gray-200 bg-gray-50 p-3 flex justify-end items-center gap-4">
            <span className="text-xs font-semibold text-gray-500 uppercase">Export Results</span>
            <div className="flex items-center gap-2">
                <select
                    className="block w-24 pl-3 pr-8 py-1.5 text-xs text-gray-700 bg-white border border-gray-300 focus:outline-none focus:ring-blue-500 focus:border-blue-500 rounded-md shadow-sm"
                    value={format}
                    onChange={(e) => setFormat(e.target.value as ExportFormat)}
                    disabled={isExporting}
                >
                    <option value="csv">CSV</option>
                    <option value="json">JSON</option>
                    <option value="xlsx">Excel</option>
                </select>
                <button
                    onClick={handleExport}
                    disabled={isExporting}
                    className="flex items-center gap-1.5 px-3 py-1.5 bg-white border border-gray-300 text-gray-700 text-xs font-medium rounded-md hover:bg-gray-50 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-blue-500 disabled:opacity-50"
                >
                    {isExporting ? <Loader2 size={14} className="animate-spin" /> : <Download size={14} />}
                    Download
                </button>
            </div>
        </div>
    );
};
