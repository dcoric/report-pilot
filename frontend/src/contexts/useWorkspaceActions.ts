import { useContext } from 'react';
import { WorkspaceActionsContext } from './workspaceActionsContextValue';

export function useWorkspaceActions() {
    const ctx = useContext(WorkspaceActionsContext);
    if (!ctx) {
        throw new Error('useWorkspaceActions must be used inside WorkspaceActionsProvider');
    }
    return ctx;
}
