// @ts-check
// The discovery job runner: at most one child process at a time, with a status record the API can
// poll. Discovery cannot run in the server process — loading the iNat taxa index alone is ~1s of
// blocked event loop and a ~650MB heap spike, and node:sqlite is synchronous throughout — so this
// forks a child and talks to it over IPC.
//
// `spawn` is injected so the whole state machine can be exercised against a fake EventEmitter:
// crash-before-first-message, exit-without-done, timeout, watchdog and cancel are all paths that
// matter and none of them should need a real process to test.
import { fileURLToPath } from 'node:url';
import { fork } from 'node:child_process';

const CHILD = fileURLToPath(new URL('./discoverChild.js', import.meta.url));
const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));

/** A run that produces no progress for this long is wedged, however long it is allowed to take. */
const WATCHDOG_MS = 10 * 60 * 1000;
/** And no run may take longer than this, whatever it claims to be doing. */
const TIMEOUT_MS = 60 * 60 * 1000;

/** The real fork, with the options that matter spelled out. */
export function forkDiscoverChild() {
    return fork(CHILD, [], {
        // Inheriting stdio would interleave the child's output with the server's NDJSON logs;
        // inheriting execArgv breaks the child outright under --inspect (port in use) and under
        // `node --test` (it tries to run itself as a test file).
        silent: true,
        execArgv: [],
        cwd: REPO_ROOT,
        serialization: 'json',
    });
}

/**
 * @param {{spawn?: () => any, timeoutMs?: number, watchdogMs?: number,
 *          now?: () => number, log?: any}} [opts]
 */
export function createJobs(opts = {}) {
    const {
        spawn = forkDiscoverChild,
        timeoutMs = TIMEOUT_MS,
        watchdogMs = WATCHDOG_MS,
        now = () => Date.now(),
        log = { info() {}, warn() {}, error() {} },
    } = opts;

    /** @type {any} */
    let child = null;
    let timers = [];
    /** @type {{state: string, phase: string|null, runId: number|null, scope: object|null,
     *          startedAt: string|null, finishedAt: string|null, counts: object|null,
     *          error: {code: string, message: string}|null, cancelling: boolean}} */
    let record = idle();

    function idle() {
        return {
            state: 'idle', phase: null, runId: null, scope: null,
            startedAt: null, finishedAt: null, counts: null, error: null, cancelling: false,
        };
    }

    function clearTimers() {
        for (const t of timers) clearTimeout(t);
        timers = [];
    }

    function armWatchdog() {
        if (timers[0]) clearTimeout(timers[0]);
        timers[0] = setTimeout(() => stop('timeout', 'No progress; the run looks wedged.'), watchdogMs);
        timers[0].unref?.();
    }

    /** Terminal transition. Everything that ends a run comes through here exactly once. */
    function settle(state, error = null) {
        if (record.state !== 'running') return;
        clearTimers();
        record = { ...record, state, error, finishedAt: new Date(now()).toISOString() };
        child = null;
    }

    function stop(reason, message) {
        if (!child) return;
        record.cancelling = true;
        log.warn({ reason }, 'stopping discovery run');
        child.kill('SIGTERM');
        // A child blocked inside a synchronous SQLite call cannot answer a signal until it
        // returns, and the worst of those is measured in seconds — so escalate late, not fast.
        const t = setTimeout(() => child?.kill('SIGKILL'), 15_000);
        t.unref?.();
        timers.push(t);
        record.error = { code: reason, message };
    }

    return {
        /**
         * Claim the single slot and start a run. Returns null if one is already going.
         *
         * **The claim must be the first thing a handler does**, with no `await` before it: two
         * simultaneous POSTs would otherwise both see `idle` and both fork.
         * @param {{scope?: object, limit?: number, recheckAfter?: number, dbFile: string,
         *           triggeredBy?: string}} config
         */
        start(config) {
            if (record.state === 'running') return null;

            record = {
                ...idle(),
                state: 'running',
                phase: 'starting',
                scope: config.scope ?? null,
                startedAt: new Date(now()).toISOString(),
            };

            child = spawn();
            child.on('message', (msg) => {
                if (!msg || typeof msg !== 'object') return;
                if (msg.type === 'progress') {
                    record.phase = msg.phase ?? record.phase;
                    if (msg.runId) record.runId = msg.runId;
                    record.counts = msg.counts ?? record.counts;
                    armWatchdog();
                } else if (msg.type === 'done') {
                    record.counts = msg.result ?? record.counts;
                    record.runId = msg.result?.runId ?? record.runId;
                    settle(msg.result?.cancelled ? 'cancelled' : 'done');
                } else if (msg.type === 'error') {
                    settle('error', { code: msg.code ?? 'run_failed', message: msg.message ?? 'The run failed.' });
                }
            });
            child.on('error', (err) => {
                // fork() itself failing — ENOMEM is plausible next to a 650MB child.
                settle('error', { code: 'spawn_failed', message: err.message });
            });
            child.on('exit', (code, signal) => {
                // Only reached when the child never reported an outcome of its own.
                if (record.cancelling) return settle('cancelled');
                settle('error', {
                    code: 'died',
                    // Never call SIGKILL "cancelled": the OOM killer sends the same signal, and
                    // reporting an out-of-memory as a user action wastes an afternoon.
                    message: signal ? `The run was killed (${signal}).` : `The run exited with code ${code}.`,
                });
            });
            child.stderr?.on('data', (b) => log.warn({ child: String(b).trim() }, 'discovery child'));

            child.send({ type: 'start', config });
            armWatchdog();
            const hard = setTimeout(() => stop('timeout', 'The run exceeded its time limit.'), timeoutMs);
            hard.unref?.();
            timers.push(hard);
            return record;
        },

        status() {
            return { ...record };
        },

        /** @param {number|null} [runId] - refuse to cancel a run the caller did not mean. */
        cancel(runId) {
            if (record.state !== 'running') return { cancelled: false, reason: 'not_running' };
            if (runId != null && record.runId != null && runId !== record.runId) {
                return { cancelled: false, reason: 'stale_run_id' };
            }
            stop('cancelled', 'Cancelled.');
            return { cancelled: true };
        },

        /** Kill any child and wait for it — the server must not exit leaving one behind. */
        async close() {
            clearTimers();
            if (!child) return;
            const dying = child;
            record.cancelling = true;
            dying.kill('SIGTERM');
            await new Promise((resolve) => {
                const t = setTimeout(() => { dying.kill('SIGKILL'); resolve(undefined); }, 5_000);
                t.unref?.();
                dying.once('exit', () => { clearTimeout(t); resolve(undefined); });
            });
            child = null;
        },
    };
}
