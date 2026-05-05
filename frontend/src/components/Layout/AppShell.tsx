import { useMemo, useState } from 'react';
import { NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom';
import {
    Bell,
    BookOpen,
    ChevronDown,
    ChevronRight,
    Database,
    HelpCircle,
    History,
    Home,
    Plus,
    Settings as SettingsIcon,
    Star,
    Terminal,
    FolderClosed,
} from 'lucide-react';
import { useDataSource } from '../../hooks/useDataSource';
import { WorkspaceActionsProvider } from '../../contexts/WorkspaceActionsContext';
import { useWorkspaceActions } from '../../contexts/useWorkspaceActions';
import appLogo from '../../assets/report-pilot.png';

const PRIMARY_NAV = [
    { path: '/dashboard', label: 'Home', icon: Home },
    { path: '/queries', label: 'Queries', icon: Terminal },
    { path: '/data-sources', label: 'Datasets', icon: Database },
    { path: '/folders', label: 'Folders', icon: FolderClosed, stub: true },
    { path: '/favorites', label: 'Favorites', icon: Star, stub: true },
    { path: '/recent', label: 'Recent', icon: History, stub: true },
];

const FOOTER_NAV = [
    { path: '/docs', label: 'Documentation', icon: BookOpen, stub: true },
    { path: '/settings', label: 'Settings', icon: SettingsIcon },
];

const PATH_LABELS: Record<string, string> = {
    '/': 'Home',
    '/dashboard': 'Home',
    '/queries': 'Saved Queries',
    '/query': 'Query Workspace',
    '/data-sources': 'Datasets',
    '/llm-providers': 'LLM Providers',
    '/schema': 'Schema Explorer',
    '/settings': 'Settings',
    '/folders': 'Folders',
    '/favorites': 'Favorites',
    '/recent': 'Recent',
    '/docs': 'Documentation',
};

function NavItem({ to, label, Icon, stub }: { to: string; label: string; Icon: typeof Home; stub?: boolean }) {
    return (
        <NavLink
            to={to}
            className={({ isActive }) => [
                'flex items-center gap-3 rounded px-3 py-2 text-sm transition-all',
                isActive
                    ? 'bg-white/10 text-white border-l-2 border-oxblood'
                    : 'text-slate-400 hover:bg-white/5 hover:text-white',
                stub ? 'opacity-60' : '',
            ].filter(Boolean).join(' ')}
            title={stub ? 'Coming soon' : undefined}
        >
            <Icon size={18} />
            <span>{label}</span>
        </NavLink>
    );
}

function HeaderInner() {
    const location = useLocation();
    const { dataSources, selectedDataSourceId, setSelectedDataSourceId } = useDataSource();
    const { actions } = useWorkspaceActions();
    const [showConnectionMenu, setShowConnectionMenu] = useState(false);

    const selectedDataSource = dataSources.find((ds) => ds.id === selectedDataSourceId);
    const pageLabel = PATH_LABELS[location.pathname] || 'Page';
    const breadcrumbTrail = actions.breadcrumb || pageLabel;

    return (
        <header className="flex h-14 w-full items-center justify-between border-b border-outline-variant bg-white px-6">
            <div className="flex items-center gap-4">
                <span className="text-base font-semibold tracking-tight text-on-surface">Data Workbench</span>
                <div className="mx-1 h-6 w-px bg-outline-variant" />
                <div className="relative flex items-center gap-2 text-[13px]">
                    <button
                        type="button"
                        onClick={() => setShowConnectionMenu((current) => !current)}
                        className="flex items-center gap-1.5 rounded font-medium text-slate-600 hover:text-slate-900"
                    >
                        <Database size={14} className="text-oxblood" />
                        <span>{selectedDataSource?.name || 'Select connection'}</span>
                        <ChevronDown size={14} />
                    </button>
                    {showConnectionMenu && (
                        <>
                            <div className="fixed inset-0 z-10" onClick={() => setShowConnectionMenu(false)} />
                            <div className="absolute top-8 left-0 z-20 w-64 rounded border border-outline-variant bg-white py-1 shadow-lg">
                                {dataSources.map((ds) => (
                                    <button
                                        key={ds.id}
                                        type="button"
                                        onClick={() => {
                                            setSelectedDataSourceId(ds.id);
                                            setShowConnectionMenu(false);
                                        }}
                                        className={[
                                            'flex w-full items-center gap-2 px-3 py-2 text-sm hover:bg-surface-container-low',
                                            ds.id === selectedDataSourceId ? 'bg-oxblood/5 text-oxblood' : 'text-slate-700',
                                        ].join(' ')}
                                    >
                                        <Database size={14} className={ds.id === selectedDataSourceId ? 'text-oxblood' : 'text-slate-400'} />
                                        <div className="flex-1 text-left">
                                            <div className="font-medium">{ds.name}</div>
                                            <div className="text-xs text-slate-500">{ds.db_type}</div>
                                        </div>
                                    </button>
                                ))}
                                {dataSources.length === 0 && (
                                    <div className="px-3 py-2 text-sm italic text-slate-400">No connections available</div>
                                )}
                            </div>
                        </>
                    )}
                    <ChevronRight size={12} className="text-slate-400" />
                    <span className="font-semibold text-slate-900">{breadcrumbTrail}</span>
                </div>
            </div>

            <div className="flex items-center gap-2">
                <button type="button" className="rounded p-2 text-slate-500 hover:bg-slate-100" title="Notifications">
                    <Bell size={18} />
                </button>
                <button type="button" className="rounded p-2 text-slate-500 hover:bg-slate-100" title="Settings">
                    <SettingsIcon size={18} />
                </button>
                <button type="button" className="rounded p-2 text-slate-500 hover:bg-slate-100" title="Help">
                    <HelpCircle size={18} />
                </button>
                <div className="mx-1 h-6 w-px bg-outline-variant" />
                {actions.onExecute && (
                    <button
                        type="button"
                        onClick={actions.onExecute}
                        disabled={actions.canExecute === false || actions.isExecuting === true}
                        className="rounded bg-oxblood-deep px-4 py-1.5 text-xs font-medium text-white shadow-sm transition-colors hover:bg-oxblood disabled:cursor-not-allowed disabled:opacity-50"
                    >
                        {actions.isExecuting ? 'Running…' : 'Execute'}
                    </button>
                )}
                <div className="ml-2 flex h-8 w-8 items-center justify-center overflow-hidden rounded-full border border-outline-variant bg-amber-accent-soft text-xs font-semibold text-on-surface">
                    DC
                </div>
            </div>
        </header>
    );
}

function AppShellInner() {
    const navigate = useNavigate();
    const NewQueryButton = useMemo(() => (
        <button
            type="button"
            onClick={() => navigate('/query')}
            className="flex w-full items-center justify-center gap-2 rounded bg-oxblood py-2 text-sm font-medium text-white transition-colors hover:bg-oxblood-soft"
        >
            <Plus size={16} />
            New Query
        </button>
    ), [navigate]);

    return (
        <div className="flex h-screen w-screen overflow-hidden">
            <aside className="z-50 flex h-screen w-64 flex-col bg-ink py-4 text-slate-400">
                <div className="mb-6 flex items-center gap-3 px-6">
                    <div className="flex h-8 w-8 items-center justify-center rounded bg-oxblood font-bold text-white">
                        <img src={appLogo} alt="Workbench" className="h-6 w-6 object-contain" />
                    </div>
                    <div>
                        <div className="text-base font-semibold leading-tight text-white">Workbench</div>
                        <div className="text-[10px] font-medium text-slate-500">v2.4.0</div>
                    </div>
                </div>

                <div className="mb-6 px-4">{NewQueryButton}</div>

                <nav className="flex-1 space-y-1 overflow-y-auto px-2">
                    {PRIMARY_NAV.map((item) => (
                        <NavItem key={item.path} to={item.path} label={item.label} Icon={item.icon} stub={item.stub} />
                    ))}
                </nav>

                <div className="mt-auto space-y-1 border-t border-white/5 px-2 pt-3">
                    {FOOTER_NAV.map((item) => (
                        <NavItem key={item.path} to={item.path} label={item.label} Icon={item.icon} stub={item.stub} />
                    ))}
                </div>
            </aside>

            <main className="relative flex flex-1 flex-col overflow-hidden bg-surface-container-low">
                <HeaderInner />
                <div className="flex-1 overflow-hidden">
                    <Outlet />
                </div>
            </main>
        </div>
    );
}

export const AppShell = () => (
    <WorkspaceActionsProvider>
        <AppShellInner />
    </WorkspaceActionsProvider>
);
