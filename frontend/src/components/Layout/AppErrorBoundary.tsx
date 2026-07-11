import { Component, createRef, type ErrorInfo, type ReactNode } from 'react';
import { AlertTriangle, RotateCcw } from 'lucide-react';

interface AppErrorBoundaryProps {
    children: ReactNode;
}

interface AppErrorBoundaryState {
    hasError: boolean;
}

export class AppErrorBoundary extends Component<AppErrorBoundaryProps, AppErrorBoundaryState> {
    state: AppErrorBoundaryState = { hasError: false };
    private readonly fallbackRef = createRef<HTMLDivElement>();

    static getDerivedStateFromError(): AppErrorBoundaryState {
        return { hasError: true };
    }

    componentDidCatch(error: Error, info: ErrorInfo): void {
        console.error('Application render failed', error, info.componentStack);
    }

    componentDidUpdate(_previousProps: AppErrorBoundaryProps, previousState: AppErrorBoundaryState): void {
        if (!previousState.hasError && this.state.hasError) {
            this.fallbackRef.current?.focus();
        }
    }

    private retry = (): void => {
        this.setState({ hasError: false });
    };

    render(): ReactNode {
        if (!this.state.hasError) return this.props.children;

        return (
            <main className="flex min-h-screen items-center justify-center bg-surface-container-low p-6">
                <div
                    ref={this.fallbackRef}
                    role="alert"
                    tabIndex={-1}
                    className="w-full max-w-lg rounded-xl border border-rose-200 bg-white p-8 text-center shadow-lg outline-none focus-visible:ring-2 focus-visible:ring-oxblood"
                >
                    <span className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-rose-50 text-rose-700">
                        <AlertTriangle size={24} aria-hidden="true" />
                    </span>
                    <h1 className="mt-4 text-xl font-bold text-slate-900">This page could not be displayed</h1>
                    <p className="mt-2 text-sm leading-6 text-slate-600">
                        Your saved data was not changed. Try rendering the page again, or return to the dashboard.
                    </p>
                    <div className="mt-6 flex flex-wrap justify-center gap-3">
                        <button
                            type="button"
                            onClick={this.retry}
                            className="inline-flex items-center gap-2 rounded-md bg-oxblood px-4 py-2 text-sm font-semibold text-white hover:bg-oxblood/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-oxblood focus-visible:ring-offset-2"
                        >
                            <RotateCcw size={15} aria-hidden="true" />
                            Try again
                        </button>
                        <a
                            href="/dashboard"
                            className="inline-flex items-center rounded-md border border-outline-variant px-4 py-2 text-sm font-semibold text-slate-700 hover:bg-surface-container-low focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-oxblood focus-visible:ring-offset-2"
                        >
                            Return to dashboard
                        </a>
                    </div>
                </div>
            </main>
        );
    }
}
