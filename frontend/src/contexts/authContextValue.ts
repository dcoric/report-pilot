import { createContext } from 'react';
import type { components } from '../lib/api/types';

export type AuthUser = components['schemas']['AuthUser'];

export type AuthStatus = 'unknown' | 'authenticated' | 'unauthenticated';

export interface AuthContextValue {
    status: AuthStatus;
    user: AuthUser | null;
    expiresAt: string | null;
    login: (email: string, password: string) => Promise<{ ok: true } | { ok: false; message: string }>;
    logout: () => Promise<void>;
    refresh: () => Promise<void>;
}

export const AuthContext = createContext<AuthContextValue | null>(null);
