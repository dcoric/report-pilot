import { useEffect, useState, type FormEvent } from 'react';
import { Navigate, useLocation, useNavigate } from 'react-router-dom';
import appLogo from '../assets/report-pilot.png';
import { useAuth } from '../hooks/useAuth';
import { client } from '../lib/api/client';
import type { components } from '../lib/api/types';

interface LocationState {
    from?: string;
}

// Provider type supporting all authentication provider types
type Provider = {
  id: string;
  name: string;
  display_name: string | null;
  type: 'oidc' | 'saml' | 'ldap' | 'ad' | 'pd';
};

export function Login() {
    const { status, login } = useAuth();
    const location = useLocation();
    const navigate = useNavigate();

    const [email, setEmail] = useState('');
    const [password, setPassword] = useState('');
    const [submitting, setSubmitting] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [providers, setProviders] = useState<Provider[]>([]);

    useEffect(() => {
        let cancelled = false;
        (async () => {
            const { data } = await client.GET('/v1/auth/providers');
            if (!cancelled && data?.items) {
                // Convert the response to the new provider type
                const convertedProviders = data.items.map(item => ({
                    id: item.id,
                    name: item.name,
                    display_name: item.display_name,
                    type: item.type as 'oidc' | 'saml' | 'ldap' | 'ad' | 'pd'
                }));
                setProviders(convertedProviders);
            }
        })();
        return () => {
            cancelled = true;
        };
    }, []);

    if (status === 'authenticated') {
        const target = (location.state as LocationState | null)?.from || '/dashboard';
        return <Navigate to={target} replace />;
    }

    async function onSubmit(event: FormEvent<HTMLFormElement>) {
        event.preventDefault();
        if (submitting) return;
        setSubmitting(true);
        setError(null);
        const result = await login(email, password);
        setSubmitting(false);
        if (result.ok) {
            const target = (location.state as LocationState | null)?.from || '/dashboard';
            navigate(target, { replace: true });
            return;
        }
        setError(result.message);
    }

    return (
        <div className="min-h-screen bg-gray-50 flex items-center justify-center px-4">
            <div className="w-full max-w-sm bg-white border border-gray-200 rounded-lg shadow-sm p-8">
                <div className="flex items-center gap-2 justify-center mb-6">
                    <img src={appLogo} alt="Report Pilot logo" className="w-8 h-8 object-contain" />
                    <span className="text-lg font-semibold text-gray-800">Report Pilot</span>
                </div>
                <h1 className="text-xl font-semibold text-gray-800 mb-1 text-center">Sign in</h1>
                <p className="text-sm text-gray-500 mb-6 text-center">
                    Use your account email and password.
                </p>

                <form onSubmit={onSubmit} className="space-y-4" noValidate>
                    <div>
                        <label htmlFor="login-email" className="block text-sm font-medium text-gray-700 mb-1">
                            Email
                        </label>
                        <input
                            id="login-email"
                            type="email"
                            autoComplete="email"
                            required
                            value={email}
                            onChange={(e) => setEmail(e.target.value)}
                            className="w-full px-3 py-2 text-sm border border-gray-200 rounded-md focus:outline-none focus:ring-2 focus:ring-oxblood focus:border-transparent"
                        />
                    </div>
                    <div>
                        <label htmlFor="login-password" className="block text-sm font-medium text-gray-700 mb-1">
                            Password
                        </label>
                        <input
                            id="login-password"
                            type="password"
                            autoComplete="current-password"
                            required
                            minLength={8}
                            value={password}
                            onChange={(e) => setPassword(e.target.value)}
                            className="w-full px-3 py-2 text-sm border border-gray-200 rounded-md focus:outline-none focus:ring-2 focus:ring-oxblood focus:border-transparent"
                            aria-describedby="login-password-hint"
                        />
                        <p id="login-password-hint" className="mt-1 text-xs text-gray-500">
                            At least 8 characters with a mix of letters and digits.
                        </p>
                    </div>

                    {error && (
                        <div
                            role="alert"
                            className="text-sm text-red-700 bg-red-50 border border-red-200 rounded-md px-3 py-2"
                        >
                            {error}
                        </div>
                    )}

                    <button
                        type="submit"
                        disabled={submitting}
                        className="w-full px-3 py-2 text-sm font-medium text-white bg-oxblood rounded-md hover:bg-oxblood-deep disabled:opacity-60 disabled:cursor-not-allowed"
                    >
                        {submitting ? 'Signing in…' : 'Sign in'}
                    </button>
                </form>

                {providers.length > 0 && (
                    <>
                        <div className="my-6 flex items-center gap-3 text-xs uppercase tracking-wider text-gray-400">
                            <span className="h-px flex-1 bg-gray-200" />
                            or
                            <span className="h-px flex-1 bg-gray-200" />
                        </div>
                        <div className="space-y-2">
                            {providers.map((provider) => {
                                if (provider.type === 'oidc' || provider.type === 'saml') {
                                    return (
                                        <a
                                            key={provider.id}
                                            href={`/v1/auth/login?provider_id=${encodeURIComponent(provider.id ?? '')}`}
                                            className="flex w-full items-center justify-center gap-2 rounded-md border border-gray-200 px-3 py-2 text-sm font-medium text-gray-700 hover:border-oxblood hover:text-oxblood"
                                        >
                                            Sign in with {provider.display_name || provider.name}
                                        </a>
                                    );
                                } else {
                                    // For non-OIDC/SAML providers, show a placeholder that would be handled by a form
                                    return (
                                        <button
                                            key={provider.id}
                                            type="button"
                                            className="flex w-full items-center justify-center gap-2 rounded-md border border-gray-200 px-3 py-2 text-sm font-medium text-gray-700 hover:border-oxblood hover:text-oxblood"
                                            onClick={() => {
                                                alert(`Login with ${provider.type} provider requires form-based authentication`);
                                            }}
                                        >
                                            Sign in with {provider.display_name || provider.name}
                                        </button>
                                    );
                                }
                            })}
                        </div>
                    </>
                )}
            </div>
        </div>
    );
}
