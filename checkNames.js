#!/usr/bin/env node
// @ts-check
// CLI wrapper: parse arguments, run discoverNames(), render the HTML/QuickStatements report from
// the accumulated DB backlog — not just this run's findings, matching checkImages.js's and
// checkLinks.js's pattern. The classification work itself is lib/discoverNames.js, which the
// server runs too.
import { openFindingsDb } from './lib/db.js';
import { ensureTaxaDb } from './lib/getInatTaxaDb.js';
import { discoverNames } from './lib/discoverNames.js';
import { generateNamesHTML } from './report/generateNamesHTML.js';
import { parseArgs, parseIucnArg, parseLimit, parseSeed } from './lib/utils.js';
import { findingsDbPath } from './lib/paths.js';
import { runMain } from './lib/cli.js';

const DB_FILE = findingsDbPath();

const args = parseArgs();
const limit = parseLimit(args, 5000);
const showAll = args.all === true;
// allInatIds() (lib/getInatTaxaDb.js) comes back in whatever incidental order SQLite emits it,
// so an unshuffled --limit run would always hit the same early slice first. Fixed seed keeps a
// from-scratch run reproducible for debugging; override with --seed for a different sample.
const seed = parseSeed(args);

/** Turn discoverNames()'s progress events into the lines this tool has always printed. */
function report(p) {
    switch (p.phase) {
        case 'querying':
            return console.log(p.iucn
                ? `Querying Wikidata for ${p.iucn} taxa with iNat IDs (limit ${limit})...`
                : `Querying Wikidata by iNat ID for taxa with iNat IDs (limit ${limit})...`);
        case 'checking':
            return console.log(`Found ${p.taxa} taxa with iNat IDs.`);
        case 'done':
            return console.log(`Recorded: ${p.open} with missing vernacular names.`);
    }
}

async function renderNamesReport(store) {
    const rows = store.listFindings({ kind: 'name', status: 'open' });
    const items = rows.map(r => ({
        wdUri: r.wdUri, qid: r.qid, inatId: r.inatTaxonId, taxonName: r.taxonName,
        missing: r.payload.missing,
    }));
    await generateNamesHTML(items);
}

async function run() {
    // Validated inside run(), not at module scope: a throw up there escapes before runMain can
    // catch it, and the user gets a stack trace where a one-line message belongs.
    const { iucnArg, iucnQid } = parseIucnArg(args);
    if (iucnQid) console.log(`IUCN filter: ${iucnArg} (${iucnQid})`);
    if (!showAll) console.log('Mode: zero-P1843 only (pass --all to include taxa that already have some names)');

    const taxaDb = await ensureTaxaDb();
    const store = openFindingsDb(DB_FILE);
    try {
        await discoverNames({
            store, taxaDb,
            scope: { iucn: typeof args.iucn === 'string' ? args.iucn : null },
            limit, seed, showAll,
            onProgress: report,
        });

        // Render the whole open backlog, not just this run — the point of the store.
        await renderNamesReport(store);
        console.log('Done.');
    } finally {
        store.close();
    }
}

runMain(run);
