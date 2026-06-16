#!/usr/bin/env node
// @ts-check
import fs from 'fs';
import { loadTaxaDb } from './getInatTaxaDb.js';
import { generateLinksHTML } from './generateLinksHTML.js';
import { loadCache, saveCache } from './cache.js';
import { HEADERS, wbk, qidFromUri, IUCN_STATUS_QIDS } from './utils.js';
import { chunk } from './generateWikitext.js';

const CACHE_FILE = 'cache-links.json';

const DEFAULT_LIMIT = 200;
const limitArg = Number.parseInt(process.argv[2], 10);
const limit = Number.isFinite(limitArg) && limitArg > 0 ? limitArg : DEFAULT_LIMIT;
const iucnArg = process.argv[3]?.toUpperCase();
const iucnQid = iucnArg ? IUCN_STATUS_QIDS[iucnArg] : null;
if (iucnArg && !iucnQid) {
    console.error(`Unknown IUCN status "${iucnArg}". Valid codes: ${Object.keys(IUCN_STATUS_QIDS).join(', ')}`);
    process.exit(1);
}

/**
 * Executes a SPARQL query against Wikidata with exponential-backoff retry on 502/503.
 * @param {string} query
 * @param {number} [retries]
 * @returns {Promise<object[]>} SPARQL result bindings
 */
async function sparql(query, retries = 3) {
    const res = await fetch(wbk.sparqlQuery(query), { headers: HEADERS });
    if ((res.status === 502 || res.status === 503) && retries > 0) {
        const delay = (4 - retries) * 3000;
        console.warn(`SPARQL HTTP ${res.status}, retrying in ${delay / 1000}s...`);
        await new Promise(r => setTimeout(r, delay));
        return sparql(query, retries - 1);
    }
    if (!res.ok) throw new Error(`SPARQL HTTP ${res.status}`);
    return (await res.json()).results.bindings;
}

/** Finds Wikidata taxa without P3151, matches them against the local iNat DB, writes links.html. */
async function run() {
    if (iucnQid) console.log(`IUCN filter: ${iucnArg} (${iucnQid})`);
    // 1. Fetch Wikidata taxa that have a scientific name but no iNat ID
    console.log(`Querying Wikidata for taxa without P3151 (limit ${limit})...`);
    const missingBindings = await sparql(`SELECT ?item ?taxonName
WHERE {
  ?item wdt:P31 wd:Q16521 .
  ?item wdt:P225 ?taxonName .
${iucnQid ? `  ?item wdt:P141 wd:${iucnQid} .\n` : ''}  FILTER NOT EXISTS { ?item wdt:P3151 ?any . }
} LIMIT ${limit}`);

    const candidates = missingBindings.map(b => ({
        wdUri: b.item.value,
        qid: qidFromUri(b.item.value),
        taxonName: b.taxonName.value,
    }));
    console.log(`Found ${candidates.length} taxa without iNat links.`);

    const cache = loadCache(CACHE_FILE);
    const today = new Date().toISOString().slice(0, 10);
    const uncached = candidates.filter(c => !cache[c.qid]);
    if (uncached.length < candidates.length)
        console.log(`Cache: skipping ${candidates.length - uncached.length} already-checked entries, scanning ${uncached.length}.`);

    // 2. Look up taxon names in local iNat taxa database
    if (uncached.length === 0) {
        console.log('No new taxa to scan. Nothing to do.');
        await generateLinksHTML([], []);
        return;
    }
    const taxaDb = await loadTaxaDb();
    const inatResults = new Map(uncached.map(c => [c.taxonName, taxaDb.get(c.taxonName) ?? null]));
    console.log(`Matched ${[...inatResults.values()].filter(Boolean).length} of ${uncached.length} names in local taxa database.`);

    // Collect only the iNat IDs we actually found
    const foundInatIds = [...inatResults.values()]
        .filter(Boolean)
        .map(v => v.inatId);

    // Save cache now — iNat API work is done; SPARQL below may fail transiently
    for (const c of uncached) cache[c.qid] = today;
    saveCache(CACHE_FILE, cache);

    if (foundInatIds.length === 0) {
        console.log('No iNat matches found. Nothing to do.');
        await generateLinksHTML([], []);
        return;
    }

    // 3. Check only the found iNat IDs against existing Wikidata P3151 mappings
    console.log(`Checking ${foundInatIds.length} found iNat IDs against existing Wikidata P3151 mappings...`);
    const valuesClause = foundInatIds.map(id => `"${id}"`).join(' ');
    const existingBindings = await sparql(`SELECT ?item ?inatId ?taxonName
WHERE {
  VALUES ?inatId { ${valuesClause} }
  ?item wdt:P3151 ?inatId .
  OPTIONAL { ?item wdt:P225 ?taxonName . }
}`);

    const existingP3151 = new Map(); // inatId → {wdUri, taxonName}
    for (const b of existingBindings) {
        existingP3151.set(b.inatId.value, {
            wdUri: b.item.value,
            taxonName: b.taxonName?.value ?? null,
        });
    }

    // 4. Cross-reference
    const matches = [];
    let conflicts = [];
    let skipped = 0;

    for (const candidate of uncached) {
        const found = inatResults.get(candidate.taxonName);
        if (!found) {
            skipped++;
            continue;
        }
        const { inatId } = found;
        const existing = existingP3151.get(inatId);

        if (!existing) {
            matches.push({ ...candidate, inatId });
        } else if (qidFromUri(existing.wdUri) !== candidate.qid) {
            conflicts.push({
                ...candidate,
                inatId,
                conflictWdUri: existing.wdUri,
                conflictQid: qidFromUri(existing.wdUri),
                conflictTaxonName: existing.taxonName,
            });
        }
        // existingP3151 points to same item → already has P3151, skip silently
    }

    // 5. Filter out conflicts where the two WD items are known homonyms (P13177)
    if (conflicts.length > 0) {
        const pairsClause = conflicts
            .map(c => `(wd:${c.qid} wd:${c.conflictQid})`)
            .join(' ');
        const homonymBindings = await sparql(`SELECT ?item1 ?item2
WHERE {
  VALUES (?item1 ?item2) { ${pairsClause} }
  { ?item1 wdt:P13177 ?item2 } UNION { ?item2 wdt:P13177 ?item1 }
}`);
        const homonymPairs = new Set(
            homonymBindings.flatMap(b => [
                `${qidFromUri(b.item1.value)}:${qidFromUri(b.item2.value)}`,
                `${qidFromUri(b.item2.value)}:${qidFromUri(b.item1.value)}`,
            ])
        );
        const beforeFilter = conflicts.length;
        conflicts = conflicts.filter(c => !homonymPairs.has(`${c.qid}:${c.conflictQid}`));
        const homonymFiltered = beforeFilter - conflicts.length;
        if (homonymFiltered > 0) {
            console.log(`Filtered ${homonymFiltered} homonym conflict(s) (P13177 link present).`);
            skipped += homonymFiltered;
        }
    }

    console.log(`Results: ${matches.length} matches, ${conflicts.length} conflicts, ${skipped} skipped (no iNat result, ambiguous, or homonym).`);

    // 5a. Build taxonomy trees for match verification
    /** @type {Map<string, {name: string, rank: string}[]>} */
    const inatTreeMap = new Map();
    for (const m of matches) inatTreeMap.set(m.inatId, taxaDb.getAncestors(m.inatId));

    /** @type {Map<string, {name: string, rankQid: string|null}[]>} */
    const wdTreeMap = new Map();
    for (const batch of chunk(matches, 50)) {
        const vals = batch.map(m => `wd:${m.qid}`).join(' ');
        const bindings = await sparql(`SELECT ?item ?directParent ?ancestor ?ancestorName ?ancestorRank ?ancestorParent WHERE {
  VALUES ?item { ${vals} }
  OPTIONAL {
    ?item wdt:P171 ?directParent .
    ?item wdt:P171+ ?ancestor .
    ?ancestor wdt:P225 ?ancestorName .
    OPTIONAL { ?ancestor wdt:P105 ?ancestorRank . }
    OPTIONAL { ?ancestor wdt:P171 ?ancestorParent . }
  }
}`);
        const byItem = new Map();
        for (const b of bindings) {
            const item = b.item.value;
            if (!byItem.has(item)) byItem.set(item, { directParent: null, ancestors: new Map() });
            const d = byItem.get(item);
            if (b.directParent && !d.directParent) d.directParent = b.directParent.value;
            if (b.ancestor) d.ancestors.set(b.ancestor.value, {
                name:    b.ancestorName?.value ?? '',
                rankQid: b.ancestorRank?.value?.split('/').pop() ?? null,
                parent:  b.ancestorParent?.value ?? null,
            });
        }
        for (const [itemUri, { directParent, ancestors }] of byItem) {
            const chain = [];
            let cur = directParent;
            while (cur && ancestors.has(cur)) {
                const a = ancestors.get(cur);
                chain.push({ name: a.name, rankQid: a.rankQid });
                cur = a.parent;
            }
            wdTreeMap.set(qidFromUri(itemUri), chain.reverse());
        }
    }

    // 5b. Write conflict bookkeeping file
    if (conflicts.length > 0) {
        const conflictFile = 'inat-links-conflicts.json';
        const conflictRecords = conflicts.map(c => ({
            inatId: c.inatId,
            matchedWdItem: c.qid,
            matchedTaxonName: c.taxonName,
            existingWdItem: c.conflictQid,
            existingTaxonName: c.conflictTaxonName,
        }));
        fs.writeFileSync(conflictFile, JSON.stringify(conflictRecords, null, 2), 'utf8');
        console.log(`Conflict bookkeeping written to ${conflictFile}.`);
    }

    // 6. Generate HTML
    await generateLinksHTML(matches, conflicts, wdTreeMap, inatTreeMap);
    console.log('Done.');
}

run().catch(err => {
    console.error('Fatal error:', err);
    process.exit(1);
});
