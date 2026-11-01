import { logEvent } from './log.js';
const MAX_OP_HISTORY = 20;
let ops = [];
let runningOp = null;
let opCounter = 0;
/** List current ops (pending + running first, then recent history). */
export function listOps() {
    return ops.slice(-MAX_OP_HISTORY).map(op => ({
        ...op,
        // Don't expose the child/timer references to the UI
        child: null,
        timer: null,
    }));
}
/** Find a running or pending op by target name. */
export function findActiveOp(target) {
    return ops.find(o => (o.status === 'pending' || o.status === 'running') && o.target === target);
}
/** Cancel a running op by id. */
export function killOp(id) {
    const op = ops.find(o => o.id === id && (o.status === 'pending' || o.status === 'running'));
    if (!op)
        return false;
    if (op.status === 'pending') {
        settleOp(op.id, 'killed');
        return true;
    }
    if (op.child) {
        try {
            op.child.kill();
        }
        catch { /* best-effort */ }
    }
    settleOp(op.id, 'killed');
    return true;
}
/** Clear finished ops from the list. */
export function clearOps() {
    ops = ops.filter(o => o.status === 'pending' || o.status === 'running');
}
/**
 * Enqueue a new operation. Returns the op id, or null when a duplicate
 * (same kind + target) is already pending or running.
 */
export function enqueueOp(kind, profile, target, label) {
    const dup = ops.find(o => (o.status === 'pending' || o.status === 'running') && o.kind === kind && o.target === target);
    if (dup)
        return { conflict: `该插件已有同样的任务在排队或执行中：${label || target}` };
    const op = {
        id: `op-${++opCounter}`,
        kind, profile, target, label,
        status: 'pending',
        startedAt: Date.now(),
        finishedAt: null,
        output: '',
        exitCode: null,
        ok: null,
        child: null,
        timer: null,
    };
    ops.push(op);
    if (ops.length > MAX_OP_HISTORY + 10) {
        // Prune old finished ops
        const terminal = ops.filter(o => o.status !== 'pending' && o.status !== 'running');
        while (ops.length > MAX_OP_HISTORY && terminal.length > 0) {
            const idx = ops.indexOf(terminal.shift());
            if (idx >= 0)
                ops.splice(idx, 1);
        }
    }
    advanceQueue();
    return { opId: op.id };
}
/** Start the next pending op; exactly one op is live at any time. */
function advanceQueue() {
    if (runningOp)
        return;
    const next = ops.find(o => o.status === 'pending');
    if (!next)
        return;
    runningOp = next;
    next.status = 'running';
    next.startedAt = Date.now();
    logEvent('info', 'op-queue', `starting ${next.id}: ${next.kind} ${next.target}`);
    // The caller (route handler) will call settleOp when done.
    // We don't auto-execute here because the route handler already has the
    // runPlugin logic — we just serialize access.
}
/**
 * Mark an op as finished and advance the queue.
 * Call this from the route handler after the operation completes.
 */
export function settleOp(id, status, exitCode, ok) {
    const op = ops.find(o => o.id === id);
    if (!op)
        return;
    op.status = status;
    op.finishedAt = Date.now();
    if (exitCode !== undefined)
        op.exitCode = exitCode;
    if (ok !== undefined)
        op.ok = ok;
    logEvent('info', 'op-queue', `settled ${id}: ${status}`);
    if (runningOp === op)
        runningOp = null;
    advanceQueue();
}
/**
 * Wait for this op to become the running one (FIFO ordering).
 * Returns when the op is no longer 'pending' (i.e. it's the current one).
 * Should be called from the route handler before starting the actual work.
 */
export async function waitForTurn(opId, signal) {
    const op = ops.find(o => o.id === opId);
    if (!op)
        return false;
    while (op.status === 'pending') {
        if (signal?.aborted)
            return false;
        await new Promise(resolve => setTimeout(resolve, 100));
    }
    return op.status === 'running';
}
/**
 * Check if this op is still the currently running one (not cancelled/evicted).
 * The route handler should check this periodically.
 */
export function isRunning(opId) {
    const op = ops.find(o => o.id === opId);
    return op !== undefined && op.status === 'running';
}
/** Append output to an op's log. */
export function appendOpOutput(opId, text) {
    const op = ops.find(o => o.id === opId);
    if (op)
        op.output = (op.output + text).slice(-100000);
}
