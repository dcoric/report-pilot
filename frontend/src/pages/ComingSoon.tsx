import { Construction } from 'lucide-react';
import { useLocation } from 'react-router-dom';

const TITLES: Record<string, string> = {
    '/folders': 'Folders',
    '/favorites': 'Favorites',
    '/recent': 'Recent',
    '/docs': 'Documentation',
};

export const ComingSoon = () => {
    const { pathname } = useLocation();
    const title = TITLES[pathname] || 'Coming Soon';

    return (
        <div className="flex h-full flex-col items-center justify-center gap-3 bg-surface-container-low p-8 text-center text-slate-500">
            <Construction size={36} className="text-amber-accent" />
            <h1 className="text-xl font-semibold text-slate-900">{title}</h1>
            <p className="max-w-sm text-sm">This area is reserved for an upcoming feature in a future release.</p>
        </div>
    );
};
