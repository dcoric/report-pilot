import { useMemo, useState, type ReactNode } from 'react';
import { WorkspaceActionsContext, type WorkspaceActions } from './workspaceActionsContextValue';

export function WorkspaceActionsProvider({ children }: { children: ReactNode }) {
    const [actions, setActions] = useState<WorkspaceActions>({});
    const value = useMemo(() => ({ actions, setActions }), [actions]);
    return <WorkspaceActionsContext.Provider value={value}>{children}</WorkspaceActionsContext.Provider>;
}
