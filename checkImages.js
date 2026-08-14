#!/usr/bin/env node
// @ts-check
import { processInatIds } from './lib/getFromInat.js';
import { generateDraftWikitext } from './lib/generateWikitext.js';
import { generateDraftsHTML } from './report/generateHTML.js';
import { generateImagesJson } from './report/generateImagesJson.js';
import { extractTaxonName } from './report/htmlShared.js';
import { openFindingsDb, DEFAULT_RECHECK_DAYS } from './lib/db.js';
import { loadTaxaDb } from './lib/getInatTaxaDb.js';
import { fetchWdTaxaByInatIds, fetchWdImagesByIucn, parseArgs, parseIucnArg, parseLimit, IUCN_QID_TO_CODE } from './lib/utils.js';
import { dataPath } from './lib/paths.js';

const DB_FILE = dataPath('findings.db');
const KIND = 'image';

const args = parseArgs();
const limit = parseLimit(args, 5000);
const { iucnArg, iucnQid } = parseIucnArg(args);
const taxonArg = typeof args.taxon === 'string' ? args.taxon : null;

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
const recheckAfter = parseRecheckAfter(args);

/**
 * Resolve a --taxon value (iNat ID or name) to a scoped set of iNat IDs: the taxon itself
 * plus all of its descendants. Exits the process on an unknown name or an ambiguous homonym.
 * @param {string} arg
 * @param {Awaited<ReturnType<typeof loadTaxaDb>>} taxaDb
 * @returns {string[]}
 */
function resolveTaxonScope(arg, taxaDb) {
    let taxonId;
    if (/^\d+$/.test(arg)) {
        taxonId = arg;
    } else {
        const matches = taxaDb.getAll(arg);
        if (matches.length === 0) {
            console.error(`Taxon "${arg}" not found in the iNat taxa index.`);
            process.exit(1);
        }
        if (matches.length > 1) {
            console.error(`Taxon "${arg}" is ambiguous (${matches.length} matches). Re-run with the iNat ID:`);
            for (const m of matches) console.error(`  ${m.inatId}  (${m.rank})`);
            process.exit(1);
        }
        taxonId = matches[0].inatId;
    }
    const ids = [taxonId, ...taxaDb.descendantInatIds(taxonId)];
    console.log(`Scope: ${arg} (${taxonId}) — ${ids.length} taxa (self + descendants).`);
    return ids;
}

/** Queries Wikidata for taxa without P18, checks iNat for CC-licensed photos, writes drafts.html. */
async function run(limit) {
    if (iucnQid) console.log(`IUCN filter: ${iucnArg} (${iucnQid})`);

    // Load the local iNat taxa DB first — its IDs drive the Wikidata query.
    const taxaDb = await loadTaxaDb();
    const store = openFindingsDb(DB_FILE);
    const runId = store.startRun('images', { iucn: iucnArg, taxon: taxonArg, limit, recheckAfter });

    // Taxa to leave alone: anything settled, plus negatives still inside the recheck window.
    // Negatives expire because CC photos keep being uploaded and missing P225s keep being filled
    // in, so "no photos" is an observation with a shelf life rather than a verdict.
    const skip = store.skipQids(KIND, recheckAfter);

    // --taxon scopes the run to a clade: the taxon itself plus all its iNat descendants.
    const scopedIds = taxonArg ? resolveTaxonScope(taxonArg, taxaDb) : null;
    const scopedSet = scopedIds ? new Set(scopedIds) : null;

    // Find Wikidata taxa with P3151 but no P18. With an IUCN status, query Wikidata
    // directly (P141 is selective, so the no-P18 set is small and WDQS answers in
    // seconds). Without one, the full no-P18 set (~619k) can't be scanned by WDQS, so
    // we invert and enumerate *by iNat ID* in bounded VALUES POST batches. Either way
    // we skip cached ids to reach genuinely new taxa; --limit caps collected uncached
    // candidates, not raw taxa scanned.
    console.log(iucnQid
        ? `Querying Wikidata for ${iucnArg} taxa without P18 (limit ${limit})...`
        : `Querying Wikidata by iNat ID for taxa without P18 (limit ${limit})...`);
    const source = iucnQid
        ? fetchWdImagesByIucn(iucnQid)
        : fetchWdTaxaByInatIds(scopedIds ?? taxaDb.allInatIds());
    const uncached = new Map(); // iNat ID → Wikidata URI
    const meta = new Map();     // Wikidata URI → { qid, inatId, iucn }
    const seenIds = new Set();
    let alreadyKnown = 0;
    for await (const row of source) {
        // The IUCN path queries Wikidata directly, so apply the --taxon scope here.
        if (scopedSet && !scopedSet.has(row.inatId)) continue;
        if (seenIds.has(row.inatId)) continue;
        seenIds.add(row.inatId);
        if (skip.has(row.qid)) { alreadyKnown++; continue; }
        uncached.set(row.inatId, row.wdUri);
        // qid and iucnQid ride along on the SPARQL row already — keep them so the taxa table
        // fills without a single extra request.
        meta.set(row.wdUri, {
            qid: row.qid,
            inatId: row.inatId,
            iucn: row.iucnQid ? IUCN_QID_TO_CODE[row.iucnQid] ?? null : null,
        });
        if (uncached.size >= limit) break;
    }
    if (alreadyKnown > 0)
        console.log(`Findings DB: skipped ${alreadyKnown} taxa already recorded.`);

    console.log(`Checking ${uncached.size} taxa against iNat for CC0/CC-BY/CC-BY-SA photos...`);
    const { available, inatTaxonIds, failed } = await processInatIds(uncached);
    console.log("iNat check complete.");

    const drafts = await generateDraftWikitext(available);
    console.log("Draft Wikitext generation complete.");

    // Record every outcome, so none of this run's work is lost and none of it is redone:
    //   photos + a draft  → open        (the actionable backlog)
    //   photos, no draft  → no_draft    (no P225 / no family template — still fixable by hand)
    //   no photos         → no_photos   (expires, see --recheck-after)
    //   batch errored     → nothing at all, so the taxon is retried next run
    let open = 0, noDraft = 0, noPhotos = 0;
    for (const [wdUri, m] of meta) {
        if (failed.has(wdUri)) continue;

        const wikitext = drafts[wdUri];
        const hasPhotos = Boolean(available[wdUri]);
        const status = !hasPhotos ? 'no_photos' : wikitext ? 'open' : 'no_draft';

        store.upsertTaxon({
            qid: m.qid,
            inatId: inatTaxonIds[wdUri] ?? m.inatId,
            taxonName: wikitext ? extractTaxonName(wikitext) : null,
            iucn: m.iucn,
        });
        store.recordFinding({ qid: m.qid, kind: KIND, status, payload: wikitext ? { wikitext } : undefined });

        if (status === 'open') open++;
        else if (status === 'no_draft') noDraft++;
        else noPhotos++;
    }
    console.log(`Recorded: ${open} open, ${noDraft} with photos but no draft, ${noPhotos} without photos`
        + (failed.size ? `, ${failed.size} unanswered (will retry)` : '') + '.');

    // Render the whole open backlog, not just this run — that is the point of the store.
    const backlog = store.openFindings(KIND);
    await generateDraftsHTML(backlog);
    generateImagesJson(backlog);
    console.log(`HTML export complete (${backlog.length} open findings in total).`);

    store.finishRun(runId, { scanned: meta.size, found: open });
    store.close();
}

run(limit).catch(err => {
    console.error('Fatal error:', err);
    process.exit(1);
});
