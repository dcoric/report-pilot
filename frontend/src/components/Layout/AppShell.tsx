import React from 'react';
import { NavLink, Outlet, useLocation } from 'react-router-dom';
import {
    LayoutDashboard,
    Database,
    Search,
    Activity,
    ShieldCheck,
    Settings,
    Layers
} from 'lucide-react';
import styles from './AppShell.module.css';

const NAV_ITEMS = [
    { path: '/', label: 'Dasbhoard', icon: LayoutDashboard },
    { path: '/data-sources', label: 'Data Sources', icon: Database },
    { path: '/schema', label: 'Schema Explorer', icon: Layers },
    { path: '/query', label: 'Query Workspace', icon: Search },
    { path: '/observability', label: 'Observability', icon: Activity },
    { path: '/release-gates', label: 'Release Gates', icon: ShieldCheck },
];

export const AppShell: React.FC = () => {
    const location = useLocation();

    return (
        <div className={styles.container}>
            {/* Sidebar */}
            <aside className={styles.sidebar}>
                <div className={styles.sidebarHeader}>
                    <LayoutDashboard className="mr-2" size={24} />
                    <span>AI-DB Console</span>
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
                    <div>
                        {/* User Profile / Actions Placeholder */}
                        <button>User</button>
                    </div>
                </header>

                <div className={styles.content}>
                    <Outlet />
                </div>
            </main>
        </div>
    );
};
