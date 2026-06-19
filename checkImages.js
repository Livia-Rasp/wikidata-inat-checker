#!/usr/bin/env node
// @ts-check
import { processInatIds } from './getFromInat.js';
import { generateDraftWikitext } from './generateWikitext.js';
import { generateDraftsHTML } from './generateHTML.js';
import { loadCache, saveCache } from './cache.js';
import { HEADERS, wbk, parseArgs, parseIucnArg } from './utils.js';

const CACHE_FILE = 'cache-images.json';

const DEFAULT_LIMIT = 5000;
const args = parseArgs();
const limitVal = Number.parseInt(args.limit, 10);
const limit = Number.isFinite(limitVal) && limitVal > 0 ? limitVal : DEFAULT_LIMIT;
const { iucnArg, iucnQid } = parseIucnArg(args);

/** Queries Wikidata for taxa without P18, checks iNat for CC-licensed photos, writes drafts.html. */
async function run(limit) {
    if (iucnQid) console.log(`IUCN filter: ${iucnArg} (${iucnQid})`);
    const sparql = `SELECT ?item ?inatID
WHERE
{
  ?item wdt:P31 wd:Q16521 .
  ?item wdt:P3151 ?inatID .
${iucnQid ? `  ?item wdt:P141 wd:${iucnQid} .\n` : ''}  FILTER (
     !EXISTS {
     ?item p:P18 ?statement1.
       }
    )
} LIMIT ${limit}`;

    const response = await fetch(wbk.sparqlQuery(sparql), { headers: HEADERS });
    const jsonRes = await response.json();

    const inatToWD = new Map();
    for (const binding of jsonRes.results.bindings) {
        inatToWD.set(binding.inatID.value, binding.item.value);
    }
    console.log(`Found ${inatToWD.size} taxa without images.`);

    const cache = loadCache(CACHE_FILE);
    const today = new Date().toISOString().slice(0, 10);
    const uncached = new Map([...inatToWD].filter(([id]) => !cache[id]));
    if (uncached.size < inatToWD.size)
        console.log(`Cache: skipping ${inatToWD.size - uncached.size} already-checked entries, scanning ${uncached.size}.`);

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
