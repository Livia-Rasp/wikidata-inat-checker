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
