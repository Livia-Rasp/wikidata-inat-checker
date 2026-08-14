#!/usr/bin/env node
// @ts-check
import { openFindingsDb } from './lib/db.js';
import { verifyOpenFindings } from './lib/verify.js';
import { generateDraftsHTML } from './report/generateHTML.js';
import { generateImagesJson } from './report/generateImagesJson.js';
import { parseArgs, parseLimit } from './lib/utils.js';
import { dataPath } from './lib/paths.js';

const DB_FILE = dataPath('findings.db');

const args = parseArgs();
const kind = typeof args.kind === 'string' ? args.kind : 'image';
const limit = parseLimit(args, 0) || undefined; // 0/absent → verify the whole open backlog

/**
 * Re-checks the open backlog against live Wikidata, then re-renders the reports so they stop
 * offering work that is already done.
 */
async function run() {
    const store = openFindingsDb(DB_FILE);
    const before = store.statusCounts(kind);
    const openBefore = before.open ?? 0;

    if (openBefore === 0) {
        console.log(`No open ${kind} findings to verify.`);
        store.close();
        return;
    }

    const runId = store.startRun('verify', { kind, limit });
    console.log(`Verifying ${limit ? Math.min(limit, openBefore) : openBefore} open ${kind} findings against Wikidata...`);

    const result = await verifyOpenFindings(store, { kind, limit });

    console.log(`Verified ${result.verified}: `
        + `${result.fixedUpstream.length} already fixed upstream, `
        + `${result.gone.length} gone (merged or deleted), `
        + `${result.stillOpen} still open.`);
    if (result.fixedUpstream.length > 0)
        console.log(`  fixed upstream: ${result.fixedUpstream.join(', ')}`);
    if (result.gone.length > 0)
        console.log(`  gone: ${result.gone.join(', ')}`);

    // Re-render, or the reports would keep offering the work until the next checkImages run.
    if (kind === 'image') {
        const backlog = store.openFindings(kind);
        await generateDraftsHTML(backlog);
        generateImagesJson(backlog);
        console.log(`Reports re-rendered (${backlog.length} open findings remain).`);
    }

    store.finishRun(runId, { scanned: result.verified, found: result.stillOpen });
    store.close();
}

run().catch(err => {
    console.error('Fatal error:', err);
    process.exit(1);
});
