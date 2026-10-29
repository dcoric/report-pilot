import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { useAuth } from '../../hooks/useAuth';

export function AccountMenu() {
    const { user, hasRole, logout } = useAuth();
    const detailsRef = useRef<HTMLDetailsElement>(null);
    const [isSigningOut, setIsSigningOut] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const name = user?.display_name || user?.email || 'Account';
    const initials = name.split(/\s+/).filter(Boolean).slice(0, 2).map((part) => part[0]).join('').toUpperCase();

    useEffect(() => {
        function closeOutside(event: PointerEvent) {
            if (event.target instanceof Node && !detailsRef.current?.contains(event.target)) {
                detailsRef.current?.removeAttribute('open');
            }
        }
        function closeOnEscape(event: KeyboardEvent) {
            if (event.key === 'Escape' && detailsRef.current?.open) {
                detailsRef.current.removeAttribute('open');
                detailsRef.current.querySelector('summary')?.focus();
            }
        }
        document.addEventListener('pointerdown', closeOutside);
        document.addEventListener('keydown', closeOnEscape);
        return () => {
            document.removeEventListener('pointerdown', closeOutside);
            document.removeEventListener('keydown', closeOnEscape);
        };
    }, []);

    async function signOut() {
        setIsSigningOut(true);
        setError(null);
        try {
            await logout();
        } catch {
            setError('Sign-out failed. Please try again.');
        } finally {
            setIsSigningOut(false);
        }
    }

    return (
        <details ref={detailsRef} className="relative ml-2">
            <summary
                aria-label={`Account menu for ${name}`}
                className="flex h-8 w-8 cursor-pointer list-none items-center justify-center rounded-full border border-outline-variant bg-amber-accent-soft text-xs font-semibold text-on-surface focus-visible:outline focus-visible:outline-2 focus-visible:outline-oxblood [&::-webkit-details-marker]:hidden"
            >
                {initials}
            </summary>
            <div className="absolute right-0 top-10 z-30 w-64 rounded border border-outline-variant bg-white py-2 text-sm text-on-surface shadow-lg">
                <div className="border-b border-outline-variant px-4 pb-2">
                    <p className="font-semibold">{name}</p>
                    <p className="break-all text-xs text-slate-600">{user?.email}</p>
                    {hasRole('admin') && <p className="mt-1 text-xs font-medium">Administrator</p>}
                </div>
                <Link to="/settings" onClick={() => detailsRef.current?.removeAttribute('open')} className="block px-4 py-2 hover:bg-slate-100">
                    Account settings
                </Link>
                <button type="button" onClick={() => void signOut()} disabled={isSigningOut} className="w-full px-4 py-2 text-left hover:bg-slate-100 disabled:opacity-50">
                    {isSigningOut ? 'Signing out…' : 'Sign out'}
                </button>
                {error && <p role="alert" className="px-4 py-2 text-xs text-red-700">{error}</p>}
            </div>
        </details>
    );
}
