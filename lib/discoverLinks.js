// @ts-check
// Discovery for the links checker: find Wikidata taxa without P3151, match them against the
// local iNat taxa index, and record what was found — a sibling to lib/discover.js, not a
// generalisation of it. The two pipelines diverge past run bookkeeping: images batches iNat photo
// lookups and builds wikitext drafts; this does a SPARQL P3151 cross-check, a P13177 homonym
// filter, and an ancestor-chain comparison. What's shared (DiscoveryError, resolveIucn,
// resolveTaxonScope, the candidate-source helpers in lib/utils.js) is imported, not duplicated.
import { DiscoveryError, resolveIucn, resolveTaxonScope } from './discover.js';
import {
    sparql, qidFromUri, chunk, shuffle, DEFAULT_SCAN_SEED,
    fetchWdTaxaByNames, fetchWdLinksByIucn, fetchWdAncestorChains, compareAncestorTrees,
    IUCN_QID_TO_CODE,
} from './utils.js';

export const KIND = 'link';

/** compareAncestorTrees' three-part bar for an unattended QuickStatements batch, unchanged from
 * checkLinks.js's --auto filter: no rank disagreement, at least 3 ranks agree, and at least one
 * of them is family or order — three obscure intermediate ranks agreeing by coincidence is not
 * enough on its own. */
export function isAutoEligible(evidence) {
    return evidence.mismatches === 0 && evidence.matches >= 3 &&
        (evidence.matchedRanks.includes('family') || evidence.matchedRanks.includes('order'));
}

/**
 * @typedef {{scanned: number, open: number, ambiguous: number, conflict: number, noMatch: number,
 *            skipped: number, runId: number, cancelled: boolean}} DiscoverLinksResult
 */

/**
 * @param {{
 *   store: any, taxaDb: any,
 *   scope?: {taxon?: string|null, iucn?: string|null},
 *   limit?: number, recheckAfter?: number, seed?: number, triggeredBy?: string,
 *   ambiguousOnly?: boolean,
 *   onProgress?: (p: {phase: string} & Record<string, any>) => void,
 *   signal?: AbortSignal,
 *   candidateSource?: AsyncIterable<any>|Iterable<any>,
 *   sparqlFn?: (query: string) => Promise<object[]>,
 * }} opts
 * @returns {Promise<DiscoverLinksResult>}
 */
export async function discoverLinks({
    store, taxaDb, scope = {}, limit = 200, recheckAfter, seed = DEFAULT_SCAN_SEED,
    triggeredBy = 'manual', ambiguousOnly = false,
    onProgress: report = () => {}, signal, candidateSource, sparqlFn = sparql,
}) {
    const iucn = resolveIucn(scope.iucn);
    // Resolved before the run row is opened: a bad scope should leave no trace of a run.
    const scoped = scope.taxon ? resolveTaxonScope(scope.taxon, taxaDb) : null;
    const scopedSet = scoped ? new Set(scoped.ids) : null;

    const runId = store.startRun('links', {
        iucn: iucn?.code ?? null, taxon: scope.taxon ?? null, limit, recheckAfter, ambiguousOnly,
    }, triggeredBy);
    const onProgress = (p) => report({ runId, ...p });
    const result = {
        scanned: 0, open: 0, ambiguous: 0, conflict: 0, noMatch: 0, skipped: 0,
        runId, cancelled: false,
    };

    let failure = null;
    try {
        // Every status, not just settled ones — a taxon deliberately skipped must not resurface on
        // the next top-up, and a negative (no_match) result only resurfaces once its recheck window
        // has passed.
        const skip = store.skipQids(KIND, recheckAfter);

        onProgress({ phase: 'querying', limit, iucn: iucn?.code ?? null });
        const source = candidateSource ?? (iucn
            ? fetchWdLinksByIucn(iucn.qid)
            : fetchWdTaxaByNames(shuffle(taxaDb.allNames(), seed)));

        const uncached = [];
        const seenQids = new Set();
        for await (const row of source) {
            if (seenQids.has(row.qid)) continue;
            seenQids.add(row.qid);
            if (skip.has(row.qid)) continue;
            uncached.push({
                wdUri: row.wdUri, qid: row.qid, taxonName: row.taxonName,
                iucn: row.iucnQid ? IUCN_QID_TO_CODE[row.iucnQid] ?? null : null,
            });
            if (uncached.length >= limit) break;
            if (signal?.aborted) break;
        }
        result.scanned = uncached.length;
        onProgress({ phase: 'checking', taxa: uncached.length });
        if (uncached.length === 0 || signal?.aborted) return result;

        // Local name lookup: undefined from get() means either no local taxon or a homonym (2+
        // active iNat taxa share the name) — getAll() is what tells those two apart.
        const singleMatch = []; // candidate + inatId + rank
        const ambiguousCandidates = []; // candidate + candidates: [{inatId, rank}, ...]
        const allByName = new Map(); // cache getAll() per unique name
        for (const c of uncached) {
            const found = taxaDb.get(c.taxonName);
            if (found) { singleMatch.push({ ...c, inatId: found.inatId, rank: found.rank }); continue; }
            if (!allByName.has(c.taxonName)) allByName.set(c.taxonName, taxaDb.getAll(c.taxonName));
            const all = allByName.get(c.taxonName);
            if (all.length >= 2) ambiguousCandidates.push({ ...c, candidates: all });
            else {
                // Genuinely absent from the local index — a negative result with a shelf life
                // (someone may add the taxon to iNat, or the WD item's name may get corrected).
                store.upsertTaxon({ qid: c.qid, taxonName: c.taxonName, iucn: c.iucn });
                store.recordFinding({ qid: c.qid, kind: KIND, status: 'no_match' });
                result.noMatch++;
            }
        }

        // Taxon scope applies only to candidates with a known local id — there is nothing to scope
        // an unmatched name against. An ambiguous item is kept if ANY of its candidates is in scope:
        // the point of review is deciding which candidate is right, and a cross-kingdom homonym
        // (the common case) will naturally have at most one candidate in any given clade anyway.
        const scopedSingleMatch = scopedSet
            ? singleMatch.filter(c => scopedSet.has(c.inatId)) : singleMatch;
        const scopedAmbiguous = scopedSet
            ? ambiguousCandidates.filter(c => c.candidates.some(cand => scopedSet.has(cand.inatId)))
            : ambiguousCandidates;

        if (signal?.aborted) { result.cancelled = true; return result; }

        if (scopedSingleMatch.length > 0 && !ambiguousOnly) {
            onProgress({ phase: 'cross-checking', taxa: scopedSingleMatch.length });
            // Which of these iNat ids does Wikidata already claim via P3151?
            const existingP3151 = new Map(); // inatId → {wdUri, taxonName}
            for (const batch of chunk(scopedSingleMatch.map(c => c.inatId), 150)) {
                const valuesClause = batch.map(id => `"${id}"`).join(' ');
                const rows = await sparqlFn(`SELECT ?item ?inatId ?taxonName
WHERE {
  VALUES ?inatId { ${valuesClause} }
  ?item wdt:P3151 ?inatId .
  OPTIONAL { ?item wdt:P225 ?taxonName . }
}`);
                for (const b of rows) {
                    existingP3151.set(b.inatId.value, {
                        wdUri: b.item.value, taxonName: b.taxonName?.value ?? null,
                    });
                }
            }

            let matches = [], conflicts = [];
            for (const candidate of scopedSingleMatch) {
                const existing = existingP3151.get(candidate.inatId);
                if (!existing) matches.push(candidate);
                else if (qidFromUri(existing.wdUri) !== candidate.qid) {
                    conflicts.push({
                        ...candidate,
                        existingWdItem: qidFromUri(existing.wdUri),
                        existingTaxonName: existing.taxonName,
                    });
                }
                // existing.wdUri's qid === candidate.qid means Wikidata already links this exact
                // pair — nothing to do; not counted, since it will simply not resurface once
                // discovered elsewhere as `open`/`done`.
            }

            // Filter out conflicts the two Wikidata items already know about via P13177.
            if (conflicts.length > 0) {
                const homonymPairs = new Set();
                for (const batch of chunk(conflicts, 100)) {
                    const pairsClause = batch.map(
                        c => `(wd:${c.qid} wd:${c.existingWdItem})`).join(' ');
                    const rows = await sparqlFn(`SELECT ?item1 ?item2
WHERE {
  VALUES (?item1 ?item2) { ${pairsClause} }
  { ?item1 wdt:P13177 ?item2 } UNION { ?item2 wdt:P13177 ?item1 }
}`);
                    for (const b of rows) {
                        const a = qidFromUri(b.item1.value), c2 = qidFromUri(b.item2.value);
                        homonymPairs.add(`${a}:${c2}`);
                        homonymPairs.add(`${c2}:${a}`);
                    }
                }
                const before = conflicts.length;
                conflicts = conflicts.filter(c => !homonymPairs.has(`${c.qid}:${c.existingWdItem}`));
                result.skipped += before - conflicts.length;
            }

            if (signal?.aborted) { result.cancelled = true; return result; }

            // Ancestor-chain evidence for both matches and conflicts — same batched fetch, same
            // shape as generateAmbiguousHTML's per-candidate comparison below.
            const wdChains = await fetchWdAncestorChains(
                [...matches, ...conflicts], sparqlFn, qidFromUri, chunk);
            for (const m of matches) {
                const evidence = compareAncestorTrees(
                    wdChains.get(m.qid) ?? [], taxaDb.getAncestors(m.inatId));
                store.upsertTaxon({
                    qid: m.qid, inatId: m.inatId, taxonName: m.taxonName, rank: m.rank, iucn: m.iucn,
                });
                store.recordFinding({
                    qid: m.qid, kind: KIND, status: 'open',
                    payload: { inatId: m.inatId, rank: m.rank, evidence, autoEligible: isAutoEligible(evidence) },
                });
                result.open++;
            }
            for (const c of conflicts) {
                const wdChain = wdChains.get(c.qid) ?? [];
                const inatChain = taxaDb.getAncestors(c.inatId);
                const evidence = compareAncestorTrees(wdChain, inatChain);
                store.upsertTaxon({
                    qid: c.qid, inatId: c.inatId, taxonName: c.taxonName, rank: c.rank, iucn: c.iucn,
                });
                store.recordFinding({
                    qid: c.qid, kind: KIND, status: 'conflict',
                    payload: {
                        inatId: c.inatId, rank: c.rank, evidence,
                        // Kept in full here (unlike `open`'s lean payload) — a conflict is a review
                        // row in the app, and the comparison table it renders needs the whole tree,
                        // not just the rank-agreement summary.
                        wdChain, inatChain,
                        existingWdItem: c.existingWdItem, existingTaxonName: c.existingTaxonName,
                    },
                });
                result.conflict++;
            }
        }

        if (signal?.aborted) { result.cancelled = true; return result; }

        // Ambiguous items always get their evidence built, even under --ambiguous-only — this is
        // the cheap half of the run and the only thing --ambiguous-only exists to produce.
        if (scopedAmbiguous.length > 0) {
            onProgress({ phase: 'ambiguous', taxa: scopedAmbiguous.length });
            const wdChains = await fetchWdAncestorChains(scopedAmbiguous, sparqlFn, qidFromUri, chunk);
            const inatChainCache = new Map(); // inatId → chain, shared across items with a shared candidate
            for (const item of scopedAmbiguous) {
                const wdChain = wdChains.get(item.qid) ?? [];
                const candidates = item.candidates.map(cand => {
                    if (!inatChainCache.has(cand.inatId))
                        inatChainCache.set(cand.inatId, taxaDb.getAncestors(cand.inatId));
                    const inatChain = inatChainCache.get(cand.inatId);
                    const evidence = compareAncestorTrees(wdChain, inatChain);
                    // Kept in full (unlike `open`'s lean payload) — the review UI's per-candidate
                    // comparison table needs the whole tree, not just the rank-agreement summary.
                    // score/scoredBy are reserved for a future ML-assisted ranking (see docs/links.md).
                    return { inatId: cand.inatId, rank: cand.rank, evidence, inatChain, score: null, scoredBy: null };
                });
                store.upsertTaxon({ qid: item.qid, taxonName: item.taxonName, iucn: item.iucn });
                store.recordFinding({
                    qid: item.qid, kind: KIND, status: 'ambiguous', payload: { wdChain, candidates },
                });
                result.ambiguous++;
            }
        }
    } catch (err) {
        failure = err;
        throw err;
    } finally {
        store.finishRun(runId, {
            scanned: result.scanned,
            found: result.open,
            state: failure ? 'failed' : result.cancelled ? 'cancelled' : 'done',
            error: failure ? String(failure.code ?? 'run_failed') : null,
        });
    }

    onProgress({ phase: 'done', ...result });
    return result;
}

export { DiscoveryError };
