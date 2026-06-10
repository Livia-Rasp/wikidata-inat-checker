import fs from 'fs';
import { findInatIds } from './getInatLinks.js';
import { generateLinksHTML } from './generateLinksHTML.js';
import { loadCache, saveCache } from './cache.js';
import { HEADERS, wbk, qidFromUri } from './utils.js';

const CACHE_FILE = 'cache-links.json';

const DEFAULT_LIMIT = 200;
const limitArg = Number.parseInt(process.argv[2], 10);
const limit = Number.isFinite(limitArg) && limitArg > 0 ? limitArg : DEFAULT_LIMIT;

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

async function run() {
    // 1. Fetch Wikidata taxa that have a scientific name but no iNat ID
    console.log(`Querying Wikidata for taxa without P3151 (limit ${limit})...`);
    const missingBindings = await sparql(`SELECT ?item ?taxonName
WHERE {
  ?item wdt:P31 wd:Q16521 .
  ?item wdt:P225 ?taxonName .
  FILTER NOT EXISTS { ?item wdt:P3151 ?any . }
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

    // 2. Search iNat by scientific name
    const taxonNames = uncached.map(c => c.taxonName);
    console.log(`Searching iNaturalist for ${taxonNames.length} taxon names...`);
    const inatResults = await findInatIds(taxonNames);

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

    // 5. Write conflict bookkeeping file
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
    await generateLinksHTML(matches, conflicts);
    console.log('Done.');
}

run().catch(err => {
    console.error('Fatal error:', err);
    process.exit(1);
});
