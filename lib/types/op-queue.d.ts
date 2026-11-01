export type OpKind = 'install' | 'update' | 'uninstall';
export type OpStatus = 'pending' | 'running' | 'done' | 'failed' | 'killed' | 'timeout' | 'refused';
export interface OpEntry {
    id: string;
    kind: OpKind;
    profile: string;
    target: string;
    label: string;
    status: OpStatus;
    startedAt: number;
    finishedAt: number | null;
    output: string;
    exitCode: number | null;
    ok: boolean | null;
    child: {
        kill: () => void;
    } | null;
    timer: ReturnType<typeof setTimeout> | null;
}
/** List current ops (pending + running first, then recent history). */
export declare function listOps(): OpEntry[];
/** Find a running or pending op by target name. */
export declare function findActiveOp(target: string): OpEntry | undefined;
/** Cancel a running op by id. */
export declare function killOp(id: string): boolean;
/** Clear finished ops from the list. */
export declare function clearOps(): void;
/**
 * Enqueue a new operation. Returns the op id, or null when a duplicate
 * (same kind + target) is already pending or running.
 */
export declare function enqueueOp(kind: OpKind, profile: string, target: string, label: string): {
    opId: string;
} | {
    conflict: string;
};
/**
 * Mark an op as finished and advance the queue.
 * Call this from the route handler after the operation completes.
 */
export declare function settleOp(id: string, status: OpStatus, exitCode?: number | null, ok?: boolean | null): void;
/**
 * Wait for this op to become the running one (FIFO ordering).
 * Returns when the op is no longer 'pending' (i.e. it's the current one).
 * Should be called from the route handler before starting the actual work.
 */
export declare function waitForTurn(opId: string, signal?: AbortSignal): Promise<boolean>;
/**
 * Check if this op is still the currently running one (not cancelled/evicted).
 * The route handler should check this periodically.
 */
export declare function isRunning(opId: string): boolean;
/** Append output to an op's log. */
export declare function appendOpOutput(opId: string, text: string): void;
