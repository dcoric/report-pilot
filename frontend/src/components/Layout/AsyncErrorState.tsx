import React from 'react';
import { AlertTriangle, RefreshCw } from 'lucide-react';

interface AsyncErrorStateProps {
    title: string;
    message: string;
    onRetry: () => void;
    isRetrying?: boolean;
}

export const AsyncErrorState: React.FC<AsyncErrorStateProps> = ({
    title,
    message,
    onRetry,
    isRetrying = false,
}) => (
    <div
        className="flex min-h-64 flex-col items-center justify-center px-6 text-center text-gray-600"
        role="alert"
    >
        <AlertTriangle className="mb-4 text-amber-500" size={40} aria-hidden="true" />
        <p className="text-lg font-medium text-gray-900">{title}</p>
        <p className="mt-1 max-w-md text-sm">{message}</p>
        <button
            type="button"
            onClick={onRetry}
            disabled={isRetrying}
            className="mt-4 inline-flex items-center gap-2 rounded-md bg-oxblood px-4 py-2 text-sm font-medium text-white transition hover:bg-oxblood-deep focus:outline-none focus:ring-2 focus:ring-oxblood focus:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-60"
        >
            <RefreshCw size={16} className={isRetrying ? 'animate-spin' : ''} aria-hidden="true" />
            {isRetrying ? 'Trying again...' : 'Try again'}
        </button>
    </div>
);
