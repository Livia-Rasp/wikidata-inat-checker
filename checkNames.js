#!/usr/bin/env node
// @ts-check
import { simplify } from 'wikibase-sdk';
import { fetchEntities } from './lib/generateWikitext.js';
import { fetchInatNames } from './lib/getInatNames.js';
import { generateNamesHTML } from './report/generateNamesHTML.js';
import { loadCache, saveCache } from './lib/cache.js';
import { sparql, qidFromUri, parseArgs, parseIucnArg, parseLimit } from './lib/utils.js';
import { cachePath } from './lib/paths.js';
import { runMain } from './lib/cli.js';

const CACHE_FILE = cachePath('cache-names.json');

const args = parseArgs();
const limit = parseLimit(args, 5000);
const showAll = args.all === true;

/** Finds iNat vernacular names absent from Wikidata P1843, writes names.html with QuickStatements. */
async function run(limit) {
    // Validated inside run(), not at module scope: a throw up there escapes before runMain can
    // catch it, and the user gets a stack trace where a one-line message belongs.
    const { iucnArg, iucnQid } = parseIucnArg(args);
    if (iucnQid) console.log(`IUCN filter: ${iucnArg} (${iucnQid})`);
    if (!showAll) console.log('Mode: zero-P1843 only (pass --all to include taxa that already have some names)');
    const query = `SELECT ?item ?inatID
WHERE {
  ?item wdt:P31 wd:Q16521 .
  ?item wdt:P3151 ?inatID .
${iucnQid ? `  ?item wdt:P141 wd:${iucnQid} .\n` : ''}} LIMIT ${limit}`;

    const bindings = await sparql(query);
    const inatToWD = new Map();
    for (const binding of bindings) {
        inatToWD.set(binding.inatID.value, binding.item.value);
    }
    console.log(`Found ${inatToWD.size} taxa with iNat IDs.`);

    const cache = loadCache(CACHE_FILE);
    const today = new Date().toISOString().slice(0, 10);
    const uncached = new Map([...inatToWD].filter(([id]) => !cache[id]));
    if (uncached.size < inatToWD.size)
        console.log(`Cache: skipping ${inatToWD.size - uncached.size} already-checked entries, scanning ${uncached.size}.`);

    // Fetch P225 + P1843 from Wikidata for all items
    const wdUris = [...uncached.values()];
    const qids = wdUris.map(qidFromUri);
    console.log(`Fetching Wikidata vernacular names for ${qids.length} items...`);

    const entities = await fetchEntities(qids);

    const wdData = {};
    for (const [qid, entity] of Object.entries(entities)) {
        if (entity.missing) continue;
        const claims = simplify.claims(entity.claims || {}, { keepRichValues: true });
        const taxonName = claims.P225?.[0];
        const wdNames = new Set(
            (claims.P1843 || []).map(v => `${v.language}:${v.text.toLowerCase()}`)
        );
        wdData[qid] = { taxonName, wdNames };
    }
    console.log('Wikidata fetch complete.');

    // Fetch iNat vernacular names
    const inatIds = [...uncached.keys()];
    console.log(`Fetching iNat vernacular names for ${inatIds.length} taxa...`);
    const inatNames = await fetchInatNames(inatIds);
    console.log('iNat fetch complete.');

    // Diff: collect names present in iNat but absent from Wikidata P1843
    const items = [];
    for (const [inatId, wdUri] of uncached) {
        const qid = qidFromUri(wdUri);
        const wd = wdData[qid];
        if (!wd) continue;
        if (!showAll && wd.wdNames.size > 0) continue;

        const inatEntries = inatNames.get(inatId) || [];
        const sciName = wd.taxonName?.toLowerCase();
        const sciGenus = sciName?.split(' ')[0];
        const missing = inatEntries.filter(({ locale, name }) => {
            const n = name.toLowerCase();
            return !wd.wdNames.has(`${locale}:${n}`) &&
                n !== sciName &&
                n !== sciGenus;
        });
        if (missing.length > 0) {
            items.push({ wdUri, qid, inatId, taxonName: wd.taxonName, missing });
        }
    }
    console.log(`Found ${items.length} items with missing vernacular names.`);

    await generateNamesHTML(items);
    console.log('HTML export complete.');

    for (const id of uncached.keys()) cache[id] = today;
    saveCache(CACHE_FILE, cache);
}

runMain(() => run(limit));
