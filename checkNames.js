#!/usr/bin/env node
// @ts-check
import { simplify } from 'wikibase-sdk';
import { fetchEntities } from './lib/generateWikitext.js';
import { fetchInatNames } from './lib/getInatNames.js';
import { ensureTaxaDb } from './lib/getInatTaxaDb.js';
import { generateNamesHTML } from './report/generateNamesHTML.js';
import { loadCache, saveCache } from './lib/cache.js';
import { qidFromUri, parseArgs, parseIucnArg, parseLimit, fetchWdTaxaLinkedByInatIds, fetchWdNamesByIucn, shuffle, DEFAULT_SCAN_SEED } from './lib/utils.js';
import { cachePath } from './lib/paths.js';
import { runMain } from './lib/cli.js';

const CACHE_FILE = cachePath('cache-names.json');

const args = parseArgs();
const limit = parseLimit(args, 5000);
const showAll = args.all === true;
// allInatIds() (lib/getInatTaxaDb.js) comes back in whatever incidental order SQLite emits it,
// so an unshuffled --limit run would always hit the same early slice first. Fixed seed keeps a
// from-scratch run reproducible for debugging; override with --seed for a different sample.
const seed = Number.parseInt(/** @type {string} */ (args.seed), 10) || DEFAULT_SCAN_SEED;

/** Finds iNat vernacular names absent from Wikidata P1843, writes names.html with QuickStatements. */
async function run(limit) {
    // Validated inside run(), not at module scope: a throw up there escapes before runMain can
    // catch it, and the user gets a stack trace where a one-line message belongs.
    const { iucnArg, iucnQid } = parseIucnArg(args);
    if (iucnQid) console.log(`IUCN filter: ${iucnArg} (${iucnQid})`);
    if (!showAll) console.log('Mode: zero-P1843 only (pass --all to include taxa that already have some names)');

    const cache = loadCache(CACHE_FILE);
    const today = new Date().toISOString().slice(0, 10);

    // Enumerate taxa already linked to iNat (P3151 present), same shape as the links and images
    // checkers: an IUCN status is selective enough for WDQS to answer directly, otherwise
    // enumerate by iNat ID in shuffled order and stop once `limit` new-to-the-cache items are
    // collected — cached ids are skipped as they stream past rather than after the fact, so a
    // mostly-cached slice does not silently return fewer than `limit` candidates.
    const taxaDb = await ensureTaxaDb();
    console.log(iucnQid
        ? `Querying Wikidata for ${iucnArg} taxa with iNat IDs (limit ${limit})...`
        : `Querying Wikidata by iNat ID for taxa with iNat IDs (limit ${limit})...`);
    const source = iucnQid
        ? fetchWdNamesByIucn(iucnQid)
        : fetchWdTaxaLinkedByInatIds(shuffle(taxaDb.allInatIds(), seed));

    const uncached = new Map(); // iNat ID → Wikidata URI
    let cachedSkipped = 0;
    for await (const row of source) {
        if (uncached.has(row.inatId)) continue;
        if (cache[row.inatId]) { cachedSkipped++; continue; }
        uncached.set(row.inatId, row.wdUri);
        if (uncached.size >= limit) break;
    }
    if (cachedSkipped > 0) console.log(`Cache: skipped ${cachedSkipped} already-checked entries.`);
    console.log(`Found ${uncached.size} taxa with iNat IDs.`);

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
