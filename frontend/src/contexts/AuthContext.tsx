import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { client } from '../lib/api/client';
import { AuthContext, type AuthStatus, type AuthUser } from './authContextValue';

export function AuthProvider({ children }: { children: ReactNode }) {
    const [status, setStatus] = useState<AuthStatus>('unknown');
    const [user, setUser] = useState<AuthUser | null>(null);
    const [expiresAt, setExpiresAt] = useState<string | null>(null);

    const refresh = useCallback(async () => {
        const { data, response } = await client.GET('/v1/auth/me');
        if (response.ok && data?.user) {
            setUser(data.user);
            setExpiresAt(data.expires_at ?? null);
            setStatus('authenticated');
            return;
        }
        setUser(null);
        setExpiresAt(null);
        setStatus('unauthenticated');
    }, []);

    useEffect(() => {
        void refresh();
    }, [refresh]);

    const login = useCallback(
        async (email: string, password: string) => {
            const { data, response } = await client.POST('/v1/auth/login', {
                body: { email, password },
            });
            if (response.ok && data?.user) {
                setUser(data.user);
                setExpiresAt(data.expires_at ?? null);
                setStatus('authenticated');
                return { ok: true } as const;
            }
            const message =
                response.status === 401
                    ? 'Invalid email or password.'
                    : `Login failed (${response.status}).`;
            return { ok: false, message } as const;
        },
        [],
    );

    const logout = useCallback(async () => {
        try {
            await client.POST('/v1/auth/logout');
        } finally {
            setUser(null);
            setExpiresAt(null);
            setStatus('unauthenticated');
        }
    }, []);

    const value = useMemo(
        () => ({ status, user, expiresAt, login, logout, refresh }),
        [status, user, expiresAt, login, logout, refresh],
    );

    return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}
