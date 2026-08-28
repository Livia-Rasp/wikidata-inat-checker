#!/usr/bin/env node
// @ts-check
// CLI wrapper: parse arguments, run discoverLinks(), render the HTML/QuickStatements reports from
// the accumulated DB backlog — not just this run's findings, matching checkImages.js's pattern.
// The classification work itself is lib/discoverLinks.js, which the server runs too.
//
// output/links-ambiguous.html keeps its exact row/column shape (id="row-{qid}", td.wd-col,
// td.taxon-col, class="candidate-row") on purpose: the sibling xgboost-inat-wikidata-match repo's
// build_gold_labeling_kit.py scrapes it with BeautifulSoup for its gold-labeling sample. See
// docs/findings-db-roadmap.md's slice 7 write-up.
import fs from 'fs';
import { openFindingsDb } from './lib/db.js';
import { ensureTaxaDb } from './lib/getInatTaxaDb.js';
import { discoverLinks } from './lib/discoverLinks.js';
import { generateLinksHTML } from './report/generateLinksHTML.js';
import { generateAmbiguousHTML } from './report/generateAmbiguousHTML.js';
import { sparql, qidFromUri, chunk, fetchWdAncestorChains, parseArgs, parseLimit, parseSeed } from './lib/utils.js';
import { outputPath, ensureParentDir, findingsDbPath } from './lib/paths.js';
import { runMain } from './lib/cli.js';

const DB_FILE = findingsDbPath();

const args = parseArgs();
const limit = parseLimit(args, 200);
const autoMode = args.auto === true;
// SELECT DISTINCT name FROM taxa (allNames(), lib/getInatTaxaDb.js) has no ORDER BY, but SQLite
// happens to emit it alphabetically — shuffled so --limit does not always collect the same
// early-alphabet slice. Fixed seed keeps a from-scratch run reproducible; override with --seed.
const seed = parseSeed(args);
// Skips the P3151 cross-check and the ancestor-chain fetch for matches — only ambiguous items are
// wanted, e.g. to source a gold-labeling sample for the sibling ML repo (see docs/links.md).
const ambiguousOnly = args['ambiguous-only'] === true;

/** Turn discoverLinks()'s progress events into the lines this tool has always printed. */
function report(p) {
    switch (p.phase) {
        case 'querying':
            return console.log(p.iucn
                ? `Querying Wikidata for ${p.iucn} taxa without P3151 (limit ${limit})...`
                : `Querying Wikidata by iNat name for taxa without P3151 (limit ${limit})...`);
        case 'checking':
            return console.log(`Collected ${p.taxa} candidate taxa without iNat links.`);
        case 'cross-checking':
            return console.log(`Checking ${p.taxa} found iNat IDs against existing Wikidata P3151 mappings...`);
        case 'ambiguous':
            return console.log(`Building evidence for ${p.taxa} ambiguous name(s)...`);
        case 'done':
            return console.log(`Recorded: ${p.open} open, ${p.conflict} conflicts, `
                + `${p.ambiguous} ambiguous, ${p.noMatch} no local match`
                + (p.skipped ? `, ${p.skipped} skipped (homonym or unresolved)` : '') + '.');
    }
}

/**
 * Ancestor chains for display are not stored in the payload (only compareAncestorTrees' evidence
 * summary is) — re-fetching them here, at report-render time, is an occasional CLI cost, not a
 * per-request one.
 */
async function fetchTreesFor(rows, taxaDb) {
    const wdTreeMap = await fetchWdAncestorChains(rows.map(r => ({ qid: r.qid })), sparql, qidFromUri, chunk);
    const inatTreeMap = new Map();
    for (const inatId of new Set(rows.map(r => r.inatId).filter(Boolean)))
        inatTreeMap.set(inatId, taxaDb.getAncestors(inatId));
    return { wdTreeMap, inatTreeMap };
}

async function renderLinksReport(store, taxaDb) {
    const openRows = store.listFindings({ kind: 'link', status: 'open' });
    const conflictRows = store.listFindings({ kind: 'link', status: 'conflict' });

    const matches = openRows.map(r => ({
        wdUri: r.wdUri, qid: r.qid, taxonName: r.taxonName, inatId: r.inatTaxonId,
    }));
    const conflicts = conflictRows.map(r => ({
        wdUri: r.wdUri, qid: r.qid, taxonName: r.taxonName, inatId: r.inatTaxonId,
        conflictWdUri: `http://www.wikidata.org/entity/${r.payload.existingWdItem}`,
        conflictQid: r.payload.existingWdItem,
        conflictTaxonName: r.payload.existingTaxonName,
    }));

    const { wdTreeMap, inatTreeMap } = await fetchTreesFor(
        [...openRows, ...conflictRows].map(r => ({ qid: r.qid, inatId: r.inatTaxonId })), taxaDb);
    await generateLinksHTML(matches, conflicts, wdTreeMap, inatTreeMap);

    if (conflicts.length > 0) {
        const conflictFile = outputPath('inat-links-conflicts.json');
        const records = conflicts.map(c => ({
            inatId: c.inatId, matchedWdItem: c.qid, matchedTaxonName: c.taxonName,
            existingWdItem: c.conflictQid, existingTaxonName: c.conflictTaxonName,
        }));
        fs.writeFileSync(ensureParentDir(conflictFile), JSON.stringify(records, null, 2), 'utf8');
        console.log(`Conflict bookkeeping written to ${conflictFile}.`);
    }
}

async function renderAmbiguousReport(store, taxaDb) {
    const rows = store.listFindings({ kind: 'link', status: 'ambiguous' });
    const items = rows.map(r => ({
        wdUri: r.wdUri, qid: r.qid, taxonName: r.taxonName,
        candidates: r.payload.candidates.map(c => ({ inatId: c.inatId, rank: c.rank })),
    }));

    const wdTreeMap = await fetchWdAncestorChains(rows.map(r => ({ qid: r.qid })), sparql, qidFromUri, chunk);
    const inatTreeMap = new Map();
    for (const item of items) for (const { inatId } of item.candidates)
        if (!inatTreeMap.has(inatId)) inatTreeMap.set(inatId, taxaDb.getAncestors(inatId));

    await generateAmbiguousHTML(items, wdTreeMap, inatTreeMap);
}

async function run() {
    const taxaDb = await ensureTaxaDb();
    const store = openFindingsDb(DB_FILE);
    try {
        await discoverLinks({
            store, taxaDb,
            scope: { iucn: typeof args.iucn === 'string' ? args.iucn : null },
            limit, seed, ambiguousOnly,
            onProgress: report,
        });

        if (autoMode && !ambiguousOnly) {
            const open = store.listFindings({ kind: 'link', status: 'open' });
            const eligible = open.filter(f => f.payload?.autoEligible === true);
            const lines = eligible.map(f => `${f.qid}\tP3151\t"${f.inatTaxonId}"`);
            const autoFile = outputPath('links-auto.qs');
            fs.writeFileSync(ensureParentDir(autoFile), lines.join('\n') + (lines.length ? '\n' : ''));
            console.log(`Auto-approved ${lines.length} / ${open.length} open matches → ${autoFile}`);
        }

        // Render the whole open backlog, not just this run — the point of the store.
        if (!ambiguousOnly) await renderLinksReport(store, taxaDb);
        await renderAmbiguousReport(store, taxaDb);
        console.log('Done.');
    } finally {
        store.close();
    }
}

runMain(run);
