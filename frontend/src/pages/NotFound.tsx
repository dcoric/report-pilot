import React from 'react';
import { Link } from 'react-router-dom';

export const NotFound: React.FC = () => {
    return (
        <div className="flex flex-col items-center justify-center h-screen bg-gray-100">
            <h1 className="text-4xl font-bold mb-4">404 - Page Not Found</h1>
            <p className="mb-6">The page you are looking for does not exist.</p>
            <Link to="/" className="text-blue-600 hover:underline">
                Go back to Dashboard
            </Link>
        </div>
    );
};
