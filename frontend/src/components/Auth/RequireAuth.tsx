import type { ReactNode } from 'react';
import { Navigate, useLocation } from 'react-router-dom';
import { useAuth } from '../../hooks/useAuth';

interface RequireAuthProps {
    children?: ReactNode;
}

export function RequireAuth({ children }: RequireAuthProps) {
    const { status } = useAuth();
    const location = useLocation();

    if (status === 'unknown') {
        return (
            <div className="flex items-center justify-center h-screen text-sm text-gray-500">
                Loading…
            </div>
        );
    }

    if (status === 'unauthenticated') {
        const redirectTo = `${location.pathname}${location.search}${location.hash}`;
        return <Navigate to="/login" replace state={{ from: redirectTo }} />;
    }

    return <>{children}</>;
}
