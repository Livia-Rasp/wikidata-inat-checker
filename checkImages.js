#!/usr/bin/env node
// @ts-check
// CLI wrapper: parse arguments, run a discovery, render the HTML report. The work itself is
// lib/discover.js, which the server runs too — see docs/dev.md.
import { discover, KIND } from './lib/discover.js';
import { generateDraftsHTML } from './report/generateHTML.js';
import { openFindingsDb, DEFAULT_RECHECK_DAYS } from './lib/db.js';
import { ensureTaxaDb } from './lib/getInatTaxaDb.js';
import { parseArgs, parseLimit, DEFAULT_SCAN_SEED } from './lib/utils.js';
import { findingsDbPath } from './lib/paths.js';
import { runMain } from './lib/cli.js';

const DB_FILE = findingsDbPath();

const args = parseArgs();
const limit = parseLimit(args, 5000);
// Fixed seed keeps a from-scratch run reproducible for debugging; override with --seed for a
// different sample (matters only for the unscoped/non-IUCN scan — see lib/discover.js).
const seed = Number.parseInt(/** @type {string} */ (args.seed), 10) || DEFAULT_SCAN_SEED;

/**
 * `--recheck-after <days>` — how long a negative finding (no photos, no draft) stays trusted
 * before the taxon becomes a candidate again. 0 re-checks every negative on this run.
 * @param {Record<string, string | true>} args
 * @returns {number}
 */
function parseRecheckAfter(args) {
    const n = Number.parseInt(/** @type {string} */ (args['recheck-after']), 10);
    return Number.isFinite(n) && n >= 0 ? n : DEFAULT_RECHECK_DAYS;
}

/** Turn the run's progress events back into the lines this tool has always printed. */
function report(p) {
    switch (p.phase) {
        case 'scope':
            return console.log(`Scope: ${p.taxon} (${p.taxonId}) — ${p.taxa} taxa (self + descendants).`);
        case 'querying':
            return console.log(p.iucn
                ? `Querying Wikidata for ${p.iucn} taxa without P18 (limit ${p.limit})...`
                : `Querying Wikidata by iNat ID for taxa without P18 (limit ${p.limit})...`);
        case 'checking':
            if (p.taxa !== undefined) {
                if (p.alreadyKnown > 0) console.log(`Findings DB: skipped ${p.alreadyKnown} taxa already recorded.`);
                return console.log(`Checking ${p.taxa} taxa against iNat for CC0/CC-BY/CC-BY-SA photos...`);
            }
            if (p.batch % 5 === 0 || p.batch === p.batches) {
                console.log(`progress: batch ${p.batch}/${p.batches}, available so far: ${p.matched}`);
            }
            return;
        case 'done':
            return console.log(
                `Recorded: ${p.open} open, ${p.noDraft} with photos but no draft, ${p.noPhotos} without photos`
                + (p.failed ? `, ${p.failed} unanswered (will retry)` : '') + '.');
    }
}

async function run() {
    const taxaDb = await ensureTaxaDb();
    const store = openFindingsDb(DB_FILE);
    try {
        await discover({
            store,
            taxaDb,
            scope: {
                taxon: typeof args.taxon === 'string' ? args.taxon : null,
                iucn: typeof args.iucn === 'string' ? args.iucn : null,
            },
            limit,
            recheckAfter: parseRecheckAfter(args),
            seed,
            onProgress: report,
        });

        // Render the whole open backlog, not just this run — that is the point of the store.
        // Deliberately here and not in discover(): a server-triggered run has no business writing
        // report files into whatever directory it happens to be running in.
        const backlog = store.openFindings(KIND);
        await generateDraftsHTML(backlog);
        console.log(`HTML export complete (${backlog.length} open findings in total).`);
    } finally {
        store.close();
    }
}

runMain(run);
