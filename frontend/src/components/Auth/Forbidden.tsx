import { Link } from 'react-router-dom';
import { ShieldAlert } from 'lucide-react';

interface ForbiddenProps {
    reason?: string;
}

export function Forbidden({ reason }: ForbiddenProps) {
    return (
        <div className="flex flex-col items-center justify-center h-full min-h-[60vh] px-6 text-center">
            <ShieldAlert className="text-oxblood mb-4" size={48} />
            <h1 className="text-xl font-semibold text-gray-800 mb-2">You don't have access to this page</h1>
            <p className="text-sm text-gray-600 max-w-md mb-4">
                {reason || 'Your account does not have the required permissions.'} Contact an administrator if you believe this is a mistake.
            </p>
            <Link
                to="/dashboard"
                className="text-sm font-medium text-oxblood hover:underline"
            >
                Back to dashboard
            </Link>
        </div>
    );
}
