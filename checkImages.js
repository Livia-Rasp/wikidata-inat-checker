#!/usr/bin/env node
// @ts-check
import { processInatIds } from './getFromInat.js';
import { generateDraftWikitext } from './generateWikitext.js';
import { generateDraftsHTML } from './generateHTML.js';
import { loadCache, saveCache } from './cache.js';
import { loadTaxaDb } from './getInatTaxaDb.js';
import { fetchWdTaxaByInatIds, parseArgs, parseIucnArg, parseLimit } from './utils.js';

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

    // Find Wikidata taxa with P3151 but no P18 by querying Wikidata *by iNat ID*
    // (bounded VALUES POST batches). This avoids scanning the full ~619k no-P18 set,
    // which WDQS cannot do, and lets us skip cached ids to reach genuinely new taxa.
    // --limit caps collected uncached candidates, not raw taxa scanned.
    console.log(`Querying Wikidata by iNat ID for taxa without P18 (limit ${limit})...`);
    const uncached = new Map(); // iNat ID → Wikidata URI
    const seenIds = new Set();
    let cachedSkipped = 0;
    for await (const row of fetchWdTaxaByInatIds(taxaDb.allInatIds(), { iucnQid })) {
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
    console.log("HTML export complete.");

    for (const id of uncached.keys()) cache[id] = today;
    saveCache(CACHE_FILE, cache);
}

run(limit).catch(err => {
    console.error('Fatal error:', err);
    process.exit(1);
});
