import type { ReactNode } from 'react';
import { Navigate, useLocation } from 'react-router-dom';
import { Forbidden } from './Forbidden';
import { useAuth } from '../../hooks/useAuth';

interface RequireAuthProps {
    children?: ReactNode;
    permission?: string;
    role?: string;
}

export function RequireAuth({ children, permission, role }: RequireAuthProps) {
    const { status, hasPermission, hasRole } = useAuth();
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

    if (role && !hasRole(role)) {
        return <Forbidden reason={`This page requires the ${role} role.`} />;
    }
    if (permission && !hasPermission(permission)) {
        return <Forbidden reason={`This page requires the ${permission} permission.`} />;
    }

    return <>{children}</>;
}
