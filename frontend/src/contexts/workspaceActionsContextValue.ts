import { createContext } from 'react';

export interface WorkspaceActions {
    onExecute?: () => void;
    isExecuting?: boolean;
    canExecute?: boolean;
    breadcrumb?: string;
}

export interface WorkspaceActionsContextValue {
    actions: WorkspaceActions;
    setActions: (actions: WorkspaceActions) => void;
}

export const WorkspaceActionsContext = createContext<WorkspaceActionsContextValue | null>(null);
