#!/usr/bin/env node
// @ts-check
import { processInatIds } from './lib/getFromInat.js';
import { generateDraftWikitext } from './lib/generateWikitext.js';
import { generateDraftsHTML } from './report/generateHTML.js';
import { generateImagesJson } from './report/generateImagesJson.js';
import { loadCache, saveCache } from './lib/cache.js';
import { loadTaxaDb } from './lib/getInatTaxaDb.js';
import { fetchWdTaxaByInatIds, fetchWdImagesByIucn, parseArgs, parseIucnArg, parseLimit } from './lib/utils.js';
import { cachePath } from './lib/paths.js';

const CACHE_FILE = cachePath('cache-images.json');

const args = parseArgs();
const limit = parseLimit(args, 5000);
const { iucnArg, iucnQid } = parseIucnArg(args);
const taxonArg = typeof args.taxon === 'string' ? args.taxon : null;

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
    const cache = loadCache(CACHE_FILE);
    const today = new Date().toISOString().slice(0, 10);

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
    const seenIds = new Set();
    let cachedSkipped = 0;
    for await (const row of source) {
        // The IUCN path queries Wikidata directly, so apply the --taxon scope here.
        if (scopedSet && !scopedSet.has(row.inatId)) continue;
        if (seenIds.has(row.inatId)) continue;
        seenIds.add(row.inatId);
        if (cache[row.inatId]) { cachedSkipped++; continue; }
        uncached.set(row.inatId, row.wdUri);
        if (uncached.size >= limit) break;
    }
    if (cachedSkipped > 0)
        console.log(`Cache: skipped ${cachedSkipped} already-checked entries.`);

    console.log(`Checking ${uncached.size} taxa against iNat for CC0/CC-BY/CC-BY-SA photos...`);
    const { available, inatTaxonIds } = await processInatIds(uncached);
    console.log("iNat check complete.");

    const drafts = await generateDraftWikitext(available);
    console.log("Draft Wikitext generation complete.");

    await generateDraftsHTML(drafts, inatTaxonIds);
    generateImagesJson(drafts, inatTaxonIds);
    console.log("HTML export complete.");

    for (const id of uncached.keys()) cache[id] = today;
    saveCache(CACHE_FILE, cache);
}

run(limit).catch(err => {
    console.error('Fatal error:', err);
    process.exit(1);
});
