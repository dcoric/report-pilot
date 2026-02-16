import React, { useState } from 'react';
import { Database, Search, User, ChevronDown } from 'lucide-react';
import appLogo from '../../assets/report-pilot.png';

interface TopHeaderProps {
    currentConnection?: string;
    dataSources: Array<{ id: string; name: string; db_type: string }>;
    onConnectionChange: (id: string) => void;
}

export const TopHeader: React.FC<TopHeaderProps> = ({
    currentConnection,
    dataSources,
    onConnectionChange
}) => {
    const [showConnectionMenu, setShowConnectionMenu] = useState(false);
    const [showUserMenu, setShowUserMenu] = useState(false);

    const selectedDataSource = dataSources.find(ds => ds.id === currentConnection);

    return (
        <header className="h-14 bg-white border-b border-gray-200 flex items-center px-4 gap-4 flex-shrink-0">
            {/* Logo */}
            <div className="flex items-center gap-2 font-bold text-gray-800">
                <img src={appLogo} alt="Report Pilot logo" className="w-5 h-5 object-contain" />
                <span>Report Pilot</span>
            </div>

            {/* Current Connection Selector */}
            <div className="relative">
                <button
                    onClick={() => setShowConnectionMenu(!showConnectionMenu)}
                    className="flex items-center gap-2 px-3 py-1.5 text-sm text-gray-600 hover:bg-gray-50 rounded-md border border-gray-200"
                >
                    <span className="text-xs text-gray-500">Current connection:</span>
                    <span className="font-medium text-gray-800">
                        {selectedDataSource?.name || 'Select connection'}
                    </span>
                    <ChevronDown size={14} />
                </button>

                {/* Connection Dropdown */}
                {showConnectionMenu && (
                    <>
                        <div
                            className="fixed inset-0 z-10"
                            onClick={() => setShowConnectionMenu(false)}
                        />
                        <div className="absolute top-full left-0 mt-1 w-64 bg-white border border-gray-200 rounded-md shadow-lg z-20 py-1">
                            {dataSources.map(ds => (
                                <button
                                    key={ds.id}
                                    onClick={() => {
                                        onConnectionChange(ds.id);
                                        setShowConnectionMenu(false);
                                    }}
                                    className={`w-full flex items-center gap-2 px-3 py-2 text-sm hover:bg-gray-50 ${
                                        ds.id === currentConnection ? 'bg-blue-50 text-blue-700' : 'text-gray-700'
                                    }`}
                                >
                                    <Database size={14} className={ds.id === currentConnection ? 'text-blue-500' : 'text-gray-400'} />
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

            {/* Global Search */}
            <div className="flex-1 max-w-md">
                <div className="relative">
                    <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 text-gray-400" size={16} />
                    <input
                        type="text"
                        placeholder="Global search..."
                        className="w-full pl-10 pr-4 py-1.5 text-sm border border-gray-200 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                    />
                </div>
            </div>

            {/* User Profile */}
            <div className="relative ml-auto">
                <button
                    onClick={() => setShowUserMenu(!showUserMenu)}
                    className="flex items-center gap-2 p-2 hover:bg-gray-50 rounded-full"
                >
                    <div className="w-8 h-8 bg-gray-200 rounded-full flex items-center justify-center">
                        <User size={18} className="text-gray-600" />
                    </div>
                </button>

                {/* User Menu Dropdown */}
                {showUserMenu && (
                    <>
                        <div
                            className="fixed inset-0 z-10"
                            onClick={() => setShowUserMenu(false)}
                        />
                        <div className="absolute top-full right-0 mt-1 w-48 bg-white border border-gray-200 rounded-md shadow-lg z-20 py-1">
                            <div className="px-3 py-2 border-b border-gray-100">
                                <div className="text-sm font-medium text-gray-800">User</div>
                                <div className="text-xs text-gray-500">user@example.com</div>
                            </div>
                            <button className="w-full px-3 py-2 text-sm text-left text-gray-700 hover:bg-gray-50">
                                Settings
                            </button>
                            <button className="w-full px-3 py-2 text-sm text-left text-gray-700 hover:bg-gray-50">
                                Logout
                            </button>
                        </div>
                    </>
                )}
            </div>
        </header>
    );
};
