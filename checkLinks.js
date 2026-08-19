#!/usr/bin/env node
// @ts-check
import fs from 'fs';
import { ensureTaxaDb } from './lib/getInatTaxaDb.js';
import { generateLinksHTML } from './report/generateLinksHTML.js';
import { generateAmbiguousHTML } from './report/generateAmbiguousHTML.js';
import { loadCache, saveCache } from './lib/cache.js';
import { sparql, qidFromUri, parseArgs, parseIucnArg, parseLimit, compareAncestorTrees, fetchWdAncestorChains, fetchWdTaxaByNames, fetchWdLinksByIucn, chunk } from './lib/utils.js';
import { outputPath, cachePath, ensureParentDir } from './lib/paths.js';
import { runMain } from './lib/cli.js';

const CACHE_FILE = cachePath('cache-links.json');

const args = parseArgs();
const limit = parseLimit(args, 200);
const autoMode = args.auto === true;

/** Finds Wikidata taxa without P3151, matches them against the local iNat DB, writes links.html. */
async function run() {
    // Validated inside run(), not at module scope: a throw up there escapes before runMain can
    // catch it, and the user gets a stack trace where a one-line message belongs.
    const { iucnArg, iucnQid } = parseIucnArg(args);
    if (iucnQid) console.log(`IUCN filter: ${iucnArg} (${iucnQid})`);

    // Load the local iNat taxa DB first — its names drive the Wikidata query.
    const taxaDb = await ensureTaxaDb();
    const cache = loadCache(CACHE_FILE);
    const today = new Date().toISOString().slice(0, 10);

    // 1. Find Wikidata taxa without P3151. With an IUCN status, query Wikidata directly
    //    (P141 is selective, so the no-P3151 set is small and WDQS answers in seconds).
    //    Without one, the full ~3M no-P3151 set can't be scanned by WDQS, so we invert and
    //    enumerate *by iNat name* in bounded VALUES POST batches. Either way --limit caps
    //    collected candidates (real iNat-name matches), not raw taxa scanned.
    console.log(iucnQid
        ? `Querying Wikidata for ${iucnArg} taxa without P3151 (limit ${limit})...`
        : `Querying Wikidata by iNat name for taxa without P3151 (limit ${limit})...`);
    const source = iucnQid
        ? fetchWdLinksByIucn(iucnQid)
        : fetchWdTaxaByNames(taxaDb.allNames());
    const uncached = [];
    const seenQids = new Set();
    let cachedSkipped = 0;
    for await (const row of source) {
        if (seenQids.has(row.qid)) continue;
        seenQids.add(row.qid);
        if (cache[row.qid]) { cachedSkipped++; continue; }
        uncached.push({ wdUri: row.wdUri, qid: row.qid, taxonName: row.taxonName });
        if (uncached.length >= limit) break;
    }
    if (cachedSkipped > 0)
        console.log(`Cache: skipped ${cachedSkipped} already-checked entries.`);
    console.log(`Collected ${uncached.length} candidate taxa without iNat links.`);

    // 2. Look up taxon names in local iNat taxa database
    if (uncached.length === 0) {
        console.log('No new taxa to scan. Nothing to do.');
        await generateLinksHTML([], []);
        await generateAmbiguousHTML([]);
        return;
    }
    const inatResults = new Map(uncached.map(c => [c.taxonName, taxaDb.get(c.taxonName) ?? null]));
    console.log(`Matched ${[...inatResults.values()].filter(Boolean).length} of ${uncached.length} names in local taxa database.`);

    // Collect only the iNat IDs we actually found
    const foundInatIds = [...inatResults.values()]
        .filter(Boolean)
        .map(v => v.inatId);

    // Collect ambiguous cases: names where get() returned null but 2+ iNat taxa share the name
    const allByName = new Map(); // cache getAll() per unique name to avoid duplicate queries
    /** @type {{ wdUri: string, qid: string, taxonName: string, candidates: {inatId: string, rank: string}[] }[]} */
    const ambiguousCandidates = [];
    for (const c of uncached) {
        if (inatResults.get(c.taxonName) !== null) continue; // skip actual matches
        if (!allByName.has(c.taxonName)) allByName.set(c.taxonName, taxaDb.getAll(c.taxonName));
        const all = allByName.get(c.taxonName);
        if (all.length >= 2) ambiguousCandidates.push({ ...c, candidates: all });
    }
    if (ambiguousCandidates.length > 0)
        console.log(`Found ${ambiguousCandidates.length} ambiguous name(s) with multiple iNat matches.`);

    // Save cache now — iNat API work is done; SPARQL below may fail transiently
    for (const c of uncached) cache[c.qid] = today;
    saveCache(CACHE_FILE, cache);

    if (foundInatIds.length === 0 && ambiguousCandidates.length === 0) {
        console.log('No iNat matches found. Nothing to do.');
        await generateLinksHTML([], []);
        await generateAmbiguousHTML([]);
        return;
    }

    let matches = [], conflicts = [], skipped = 0;
    const inatTreeMap = new Map();
    const wdTreeMap   = new Map();

    if (foundInatIds.length > 0) {
        // 3. Check only the found iNat IDs against existing Wikidata P3151 mappings
        console.log(`Checking ${foundInatIds.length} found iNat IDs against existing Wikidata P3151 mappings...`);
        const existingP3151 = new Map(); // inatId → {wdUri, taxonName}
        for (const batch of chunk(foundInatIds, 150)) {
            const valuesClause = batch.map(id => `"${id}"`).join(' ');
            const existingBindings = await sparql(`SELECT ?item ?inatId ?taxonName
WHERE {
  VALUES ?inatId { ${valuesClause} }
  ?item wdt:P3151 ?inatId .
  OPTIONAL { ?item wdt:P225 ?taxonName . }
}`);
            for (const b of existingBindings) {
                existingP3151.set(b.inatId.value, {
                    wdUri: b.item.value,
                    taxonName: b.taxonName?.value ?? null,
                });
            }
        }

        // 4. Cross-reference
        for (const candidate of uncached) {
            const found = inatResults.get(candidate.taxonName);
            if (!found) { skipped++; continue; }
            const { inatId } = found;
            const existing = existingP3151.get(inatId);
            if (!existing) {
                matches.push({ ...candidate, inatId });
            } else if (qidFromUri(existing.wdUri) !== candidate.qid) {
                conflicts.push({
                    ...candidate, inatId,
                    conflictWdUri: existing.wdUri,
                    conflictQid: qidFromUri(existing.wdUri),
                    conflictTaxonName: existing.taxonName,
                });
            }
        }

        // 5. Filter out conflicts where the two WD items are known homonyms (P13177)
        if (conflicts.length > 0) {
            const homonymPairs = new Set();
            for (const batch of chunk(conflicts, 100)) {
                const pairsClause = batch.map(c => `(wd:${c.qid} wd:${c.conflictQid})`).join(' ');
                const homonymBindings = await sparql(`SELECT ?item1 ?item2
WHERE {
  VALUES (?item1 ?item2) { ${pairsClause} }
  { ?item1 wdt:P13177 ?item2 } UNION { ?item2 wdt:P13177 ?item1 }
}`);
                for (const b of homonymBindings) {
                    const a = qidFromUri(b.item1.value), c2 = qidFromUri(b.item2.value);
                    homonymPairs.add(`${a}:${c2}`);
                    homonymPairs.add(`${c2}:${a}`);
                }
            }
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
        for (const m of matches) inatTreeMap.set(m.inatId, taxaDb.getAncestors(m.inatId));
        for (const [qid, chain] of await fetchWdAncestorChains(matches, sparql, qidFromUri, chunk))
            wdTreeMap.set(qid, chain);

        // 5b. Write conflict bookkeeping file
        if (conflicts.length > 0) {
            const conflictFile = outputPath('inat-links-conflicts.json');
            const conflictRecords = conflicts.map(c => ({
                inatId: c.inatId,
                matchedWdItem: c.qid,
                matchedTaxonName: c.taxonName,
                existingWdItem: c.conflictQid,
                existingTaxonName: c.conflictTaxonName,
            }));
            fs.writeFileSync(ensureParentDir(conflictFile), JSON.stringify(conflictRecords, null, 2), 'utf8');
            console.log(`Conflict bookkeeping written to ${conflictFile}.`);
        }
    }

    // 6. Build taxonomy trees for ambiguous candidates
    const wdAmbigTreeMap = await fetchWdAncestorChains(ambiguousCandidates, sparql, qidFromUri, chunk);

    /** @type {Map<string, {name: string, rank: string}[]>} */
    const inatAmbigTreeMap = new Map();
    for (const item of ambiguousCandidates)
        for (const { inatId } of item.candidates)
            if (!inatAmbigTreeMap.has(inatId))
                inatAmbigTreeMap.set(inatId, taxaDb.getAncestors(inatId));

    // 7. Auto-export: filter matches by tree agreement and write links-auto.qs
    if (autoMode) {
        const safeLines = [];
        for (const m of matches) {
            const wdChain   = wdTreeMap.get(m.qid) ?? [];
            const inatChain = inatTreeMap.get(m.inatId) ?? [];
            const { matches: rankMatches, mismatches, matchedRanks } = compareAncestorTrees(wdChain, inatChain);
            if (mismatches === 0 && rankMatches >= 3 &&
                (matchedRanks.includes('family') || matchedRanks.includes('order'))) {
                safeLines.push(`${m.qid}\tP3151\t"${m.inatId}"`);
            }
        }
        const autoFile = outputPath('links-auto.qs');
        fs.writeFileSync(ensureParentDir(autoFile), safeLines.join('\n') + (safeLines.length ? '\n' : ''));
        console.log(`Auto-approved ${safeLines.length} / ${matches.length} matches → ${autoFile}`);
    }

    // 8. Generate HTML
    await generateLinksHTML(matches, conflicts, wdTreeMap, inatTreeMap);
    await generateAmbiguousHTML(ambiguousCandidates, wdAmbigTreeMap, inatAmbigTreeMap);
    console.log('Done.');
}

runMain(run);
