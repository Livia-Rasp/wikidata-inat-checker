#!/usr/bin/env node
// @ts-check
import { processInatIds } from './getFromInat.js';
import { generateDraftWikitext } from './generateWikitext.js';
import { generateDraftsHTML } from './generateHTML.js';
import { generateImagesJson } from './generateImagesJson.js';
import { loadCache, saveCache } from './cache.js';
import { loadTaxaDb } from './getInatTaxaDb.js';
import { fetchWdTaxaByInatIds, fetchWdTaxaByIucn, parseArgs, parseIucnArg, parseLimit } from './utils.js';

const CACHE_FILE = 'cache-images.json';

const args = parseArgs();
const limit = parseLimit(args, 5000);
const { iucnArg, iucnQid } = parseIucnArg(args);

/** Queries Wikidata for taxa without P18, checks iNat for CC-licensed photos, writes drafts.html. */
async function run(limit) {
    if (iucnQid) console.log(`IUCN filter: ${iucnArg} (${iucnQid})`);

    // Load the local iNat taxa DB first — its IDs drive the Wikidata query.
    const taxaDb = await loadTaxaDb();
    const cache = loadCache(CACHE_FILE);
    const today = new Date().toISOString().slice(0, 10);

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
        ? fetchWdTaxaByIucn(iucnQid)
        : fetchWdTaxaByInatIds(taxaDb.allInatIds());
    const uncached = new Map(); // iNat ID → Wikidata URI
    const seenIds = new Set();
    let cachedSkipped = 0;
    for await (const row of source) {
        if (seenIds.has(row.inatId)) continue;
        seenIds.add(row.inatId);
        if (cache[row.inatId]) { cachedSkipped++; continue; }
        uncached.set(row.inatId, row.wdUri);
        if (uncached.size >= limit) break;
    }
    if (cachedSkipped > 0)
        console.log(`Cache: skipped ${cachedSkipped} already-checked entries.`);

    console.log(`Checking ${uncached.size} taxa against iNat for CC0 photos...`);
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
