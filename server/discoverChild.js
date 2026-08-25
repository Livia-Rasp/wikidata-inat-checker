#!/usr/bin/env node
// @ts-check
// The forked half of a discovery run. Opens its own findings-database handle and its own read-only
// taxa index, runs lib/discover.js, and reports over IPC.
//
// Thin on purpose: everything worth testing is in lib/discover.js or server/jobs.js.
import { openFindingsDb } from '../lib/db.js';
import { openTaxaDb, TaxaIndexUnavailable } from '../lib/getInatTaxaDb.js';
import { discover, DiscoveryError } from '../lib/discover.js';
import { discoverLinks } from '../lib/discoverLinks.js';
import { discoverNames } from '../lib/discoverNames.js';

/** config.tool picks which pipeline runs; 'images' stays the default for backward compatibility. */
const RUNNERS = { images: discover, links: discoverLinks, names: discoverNames };

// The only thing that stops this outliving a parent that was killed outright: the IPC channel
// closes when the parent dies, however it dies.
process.on('disconnect', () => process.exit(0));

const controller = new AbortController();
process.on('SIGTERM', () => controller.abort());

/** Progress is coalesced to at most one message a second — phase changes always go through. */
function makeReporter() {
    let last = 0;
    let lastPhase = null;
    return (p) => {
        const changed = p.phase !== lastPhase;
        if (!changed && Date.now() - last < 1000) return;
        last = Date.now();
        lastPhase = p.phase;
        const { phase, runId, ...counts } = p;
        process.send?.({ type: 'progress', phase, runId, counts });
    };
}

process.once('message', async (msg) => {
    if (!msg || msg.type !== 'start') return;
    const { tool = 'images', scope, limit, recheckAfter, dbFile, triggeredBy } = msg.config;
    const run = RUNNERS[tool];

    let store;
    try {
        const taxaDb = openTaxaDb();
        store = openFindingsDb(dbFile);
        const result = await run({
            store, taxaDb, scope, limit, recheckAfter, triggeredBy,
            onProgress: makeReporter(),
            signal: controller.signal,
        });
        // Not process.exit() straight after: send is asynchronous and exiting discards queued
        // frames. Closing the store and letting the loop drain is what gets the message out.
        process.send?.({ type: 'done', result });
    } catch (err) {
        const code = err instanceof DiscoveryError || err instanceof TaxaIndexUnavailable
            ? err.code
            : 'run_failed';
        // Only messages we chose: a node:sqlite error carries the absolute path of the database.
        const message = code === 'run_failed' ? 'The discovery run failed.' : err.message;
        process.send?.({ type: 'error', code, message });
    } finally {
        store?.close();
        process.disconnect?.();
    }
});
