// @ts-check
// The tail every entry script ends with, in one place.
//
// All seven of them used to close with their own copy of `run().catch(err => { … exit(1) })`, in
// two different formattings, and one of them additionally knew how to print a DiscoveryError.
// Small duplication, but it is the last thing a reader sees in each file.
//
// The distinction worth keeping is between a *bug* and a *usage error*. A stack trace is the right
// output for the first and pure noise for the second — nobody mistyping `--iucn ZZ` wants to read
// a trace through the argument parser. So an error marked `expected` prints its message alone,
// with any `hints` indented beneath it.
import { AppError } from './errors.js';

/**
 * An error caused by how the tool was invoked, not by a defect in it: an unknown flag value, a
 * taxon name that matches nothing. Carries no stack trace to the user.
 */
export class UsageError extends AppError {
    /**
     * @param {string} message
     * @param {string[]} [hints] extra lines to print indented under the message
     */
    constructor(message, hints = []) {
        super(message);
        this.hints = hints;
    }
}

/** Conventional 128 + signal number, so a shell sees the run did not finish on its own. */
const SIGNAL_EXIT = { SIGINT: 130, SIGTERM: 143 };

/**
 * Make a checker's run stop honestly on Ctrl-C or SIGTERM, instead of dying with its `runs` row
 * still claiming `running` — Node's default SIGINT exits without unwinding, so the pipeline's
 * `finally → finishRun` never runs.
 *
 * Two stages, like the server's cancel-then-kill:
 * 1. The first signal aborts `signal`. The pipeline stops at its next check, its own `finally`
 *    records the run as `cancelled`, and everything already recorded is kept.
 * 2. A second signal marks the run `interrupted` and exits at once — for an in-flight iNat batch
 *    that is still tens of seconds from the next check.
 *
 * Only the caller's own row is touched, never a sweep: the server's discovery child may have a
 * live run in the same database, and from a row alone nothing can tell "died" from "still going"
 * (see docs/todo.md). A signal before the run id is known has no row to mark, so it just exits.
 *
 * Create it immediately before the pipeline call and dispose it immediately after, so a Ctrl-C
 * during report rendering gets Node's ordinary behaviour again.
 *
 * @param {{interruptRun(id: number): number}} store
 * @param {{
 *   graceful?: boolean,
 *   proc?: {on: Function, off: Function, exit: (code: number) => void},
 *   log?: {error: Function},
 * }} [opts] `graceful: false` for a caller with no abort plumbing: the first signal interrupts.
 */
export function interruptibleRun(store, { graceful = true, proc = process, log = console } = {}) {
    const controller = new AbortController();
    /** @type {number|null} */
    let runId = null;

    /** @param {string} sig */
    const onSignal = (sig) => {
        if (graceful && runId !== null && !controller.signal.aborted) {
            controller.abort();
            log.error(`\n${sig}: stopping after the current step, keeping what is recorded. Ctrl-C again to quit at once.`);
            return;
        }
        if (runId !== null) store.interruptRun(runId);
        proc.exit(SIGNAL_EXIT[sig] ?? 130);
    };
    proc.on('SIGINT', onSignal);
    proc.on('SIGTERM', onSignal);

    return {
        signal: controller.signal,
        /** Whether a signal asked the run to stop. */
        get stopped() { return controller.signal.aborted; },
        /** For a caller that opens the run row itself. @param {number} id */
        setRunId(id) { runId = id; },
        /**
         * Wrap a progress reporter so the run id is learned from the first report — every
         * pipeline stamps it on each one (`runProgress` in lib/discover.js).
         * @template {Record<string, any>} P
         * @param {(p: P) => void} report
         * @returns {(p: P) => void}
         */
        track(report) {
            return (p) => {
                if (typeof p?.runId === 'number') runId = p.runId;
                report(p);
            };
        },
        dispose() {
            proc.off('SIGINT', onSignal);
            proc.off('SIGTERM', onSignal);
        },
    };
}

/**
 * Run an entry script's main function and own the process's exit.
 *
 * Note this deliberately does *not* catch inside the tools: library code throws, and only here —
 * at the edge, where there is a process to exit — does anything call `process.exit`. That is the
 * same rule `lib/discover.js` follows so the server can call it without a bad argument becoming a
 * remote kill.
 *
 * @param {() => Promise<void>} fn
 */
export function runMain(fn) {
    fn().catch((err) => {
        if (err?.expected) {
            console.error(err.message);
            for (const hint of err.hints ?? []) console.error(`  ${hint}`);
        } else {
            console.error('Fatal error:', err);
        }
        process.exit(1);
    });
}
