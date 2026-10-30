import { useCallback, useState } from 'react';

type RefinementChain = {
    dataSourceId: string;
    // Session whose successful result is on screen; new asks refine its SQL.
    sessionId: string;
    // Prompts that produced the displayed result, oldest first.
    turns: string[];
};

export type RefinementCommit = {
    dataSourceId: string;
    sessionId: string;
    question: string;
    parentSessionId: string | null;
};

const NO_TURNS: string[] = [];

/**
 * Tracks the session behind the displayed result and the prompts that built it,
 * so follow-up questions can be sent as refinements of that session.
 */
export function useRefinementChain(selectedDataSourceId: string) {
    const [chain, setChain] = useState<RefinementChain | null>(null);

    // Parent sessions must belong to the selected data source, so a source
    // switch ends the chain.
    if (chain && chain.dataSourceId !== selectedDataSourceId) {
        setChain(null);
    }
    const activeChain = chain?.dataSourceId === selectedDataSourceId ? chain : null;

    const commitTurn = useCallback(({ dataSourceId, sessionId, question, parentSessionId }: RefinementCommit) => {
        setChain((previous) => {
            const extendsPrevious = Boolean(
                parentSessionId
                && previous
                && previous.sessionId === parentSessionId
                && previous.dataSourceId === dataSourceId,
            );
            return {
                dataSourceId,
                sessionId,
                turns: extendsPrevious && previous ? [...previous.turns, question] : [question],
            };
        });
    }, []);

    // A manual SQL run replaces the result without a new prompt.
    const adoptSession = useCallback((dataSourceId: string, sessionId: string) => {
        setChain((previous) => ({
            dataSourceId,
            sessionId,
            turns: previous?.dataSourceId === dataSourceId ? previous.turns : NO_TURNS,
        }));
    }, []);

    const resetChain = useCallback(() => setChain(null), []);

    return {
        resultSessionId: activeChain?.sessionId ?? null,
        refinementTurns: activeChain?.turns ?? NO_TURNS,
        commitTurn,
        adoptSession,
        resetChain,
    };
}
