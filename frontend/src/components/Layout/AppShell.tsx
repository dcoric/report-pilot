import React, { useState } from 'react';
import { NavLink, Outlet, useLocation } from 'react-router-dom';
import {
    LayoutDashboard,
    Database,
    Search,
    Settings,
    Layers,
    Server,
    ChevronDown
} from 'lucide-react';
import styles from './AppShell.module.css';
import { useDataSource } from '../../hooks/useDataSource';
import appLogo from '../../assets/report-pilot.png';

const NAV_ITEMS = [
    { path: '/dashboard', label: 'Dashboard', icon: LayoutDashboard },
    { path: '/data-sources', label: 'Data Sources', icon: Database },
    { path: '/llm-providers', label: 'LLM Providers', icon: Server },
    { path: '/schema', label: 'Schema Explorer', icon: Layers },
    { path: '/query', label: 'Query Workspace', icon: Search },
];

export const AppShell: React.FC = () => {
    const location = useLocation();
    const { dataSources, selectedDataSourceId, setSelectedDataSourceId } = useDataSource();
    const [showConnectionMenu, setShowConnectionMenu] = useState(false);

    const selectedDataSource = dataSources.find(ds => ds.id === selectedDataSourceId);

    return (
        <div className={styles.container}>
            {/* Sidebar */}
            <aside className={styles.sidebar}>
                <div className={styles.sidebarHeader}>
                    <div className="mr-2 h-7 w-7 rounded-md bg-white p-1 shadow-sm flex items-center justify-center">
                        <img src={appLogo} alt="Report Pilot logo" className="h-full w-full object-contain" />
                    </div>
                    <span>Report Pilot</span>
                </div>

                <div className={styles.sidebarContent}>
                    <div className={styles.navSection}>
                        <div className={styles.navSectionTitle}>Platform</div>
                        {NAV_ITEMS.map((item) => (
                            <NavLink
                                key={item.path}
                                to={item.path}
                                className={({ isActive }) =>
                                    `${styles.navItem} ${isActive ? styles.navItemActive : ''}`
                                }
                            >
                                <item.icon size={18} />
                                <span>{item.label}</span>
                            </NavLink>
                        ))}
                    </div>

                    <div className={styles.navSection}>
                        <div className={styles.navSectionTitle}>Settings</div>
                        <NavLink
                            to="/settings"
                            className={({ isActive }) =>
                                `${styles.navItem} ${isActive ? styles.navItemActive : ''}`
                            }
                        >
                            <Settings size={18} />
                            <span>Configuration</span>
                        </NavLink>
                    </div>
                </div>
            </aside>

            {/* Main Content */}
            <main className={styles.main}>
                <header className={styles.header}>
                    <div className={styles.breadcrumbs}>
                        Home &gt; {NAV_ITEMS.find(i => i.path === location.pathname)?.label || 'Page'}
                    </div>

                    {/* Data Source Selector */}
                    <div className="relative">
                        <button
                            onClick={() => setShowConnectionMenu(!showConnectionMenu)}
                            className="flex items-center gap-2 px-3 py-1.5 text-sm text-gray-600 hover:bg-gray-50 rounded-md border border-gray-200"
                        >
                            <Database size={14} className="text-blue-500" />
                            <span className="font-medium text-gray-800">
                                {selectedDataSource?.name || 'Select connection'}
                            </span>
                            <ChevronDown size={14} />
                        </button>

                        {showConnectionMenu && (
                            <>
                                <div
                                    className="fixed inset-0 z-10"
                                    onClick={() => setShowConnectionMenu(false)}
                                />
                                <div className="absolute top-full right-0 mt-1 w-64 bg-white border border-gray-200 rounded-md shadow-lg z-20 py-1">
                                    {dataSources.map(ds => (
                                        <button
                                            key={ds.id}
                                            onClick={() => {
                                                setSelectedDataSourceId(ds.id);
                                                setShowConnectionMenu(false);
                                            }}
                                            className={`w-full flex items-center gap-2 px-3 py-2 text-sm hover:bg-gray-50 ${
                                                ds.id === selectedDataSourceId ? 'bg-blue-50 text-blue-700' : 'text-gray-700'
                                            }`}
                                        >
                                            <Database size={14} className={ds.id === selectedDataSourceId ? 'text-blue-500' : 'text-gray-400'} />
                                            <div className="flex-1 text-left">
                                                <div className="font-medium">{ds.name}</div>
                                                <div className="text-xs text-gray-500">{ds.db_type}</div>
                                            </div>
                                        </button>
                                    ))}
                                    {dataSources.length === 0 && (
                                        <div className="px-3 py-2 text-sm text-gray-400 italic">No connections available</div>
                                    )}
                                </div>
                            </>
                        )}
                    </div>
                </header>

                <div className={styles.content}>
                    <Outlet />
                </div>
            </main>
        </div>
    );
};
