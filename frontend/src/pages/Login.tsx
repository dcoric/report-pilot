import { useState, type FormEvent } from 'react';
import { Navigate, useLocation, useNavigate } from 'react-router-dom';
import appLogo from '../assets/report-pilot.png';
import { useAuth } from '../hooks/useAuth';

interface LocationState {
    from?: string;
}

export function Login() {
    const { status, login } = useAuth();
    const location = useLocation();
    const navigate = useNavigate();

    const [email, setEmail] = useState('');
    const [password, setPassword] = useState('');
    const [submitting, setSubmitting] = useState(false);
    const [error, setError] = useState<string | null>(null);

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
                            value={password}
                            onChange={(e) => setPassword(e.target.value)}
                            className="w-full px-3 py-2 text-sm border border-gray-200 rounded-md focus:outline-none focus:ring-2 focus:ring-oxblood focus:border-transparent"
                        />
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
            </div>
        </div>
    );
}
