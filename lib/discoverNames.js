// @ts-check
// Discovery for the names checker: find iNat vernacular names missing from Wikidata's P1843, and
// record what was found — a sibling to lib/discover.js and lib/discoverLinks.js, not a
// generalisation of either. Unlike links, there is no "which iNat taxon" ambiguity here: every
// candidate already has a confirmed inatId from a P3151-linked WD item, so recording happens in
// one pass after the batched Wikidata + iNat fetches — the same shape discoverLinks.js uses, not
// discover.js's per-iNat-batch shape, which exists only because images' per-taxon photo lookups
// are expensive and worth being able to interrupt mid-run.
import { simplify } from 'wikibase-sdk';
import { resolveIucn, resolveTaxonScope } from './discover.js';
import { fetchEntities } from './generateWikitext.js';
import { fetchInatNames } from './getInatNames.js';
import {
    shuffle, DEFAULT_SCAN_SEED, IUCN_QID_TO_CODE,
    fetchWdTaxaLinkedByInatIds, fetchWdNamesByIucn,
} from './utils.js';

export const KIND = 'name';

/** @typedef {{scanned: number, open: number, runId: number, cancelled: boolean}} DiscoverNamesResult */

/**
 * @param {{
 *   store: any, taxaDb: any,
 *   scope?: {taxon?: string|null, iucn?: string|null},
 *   limit?: number, recheckAfter?: number, seed?: number, triggeredBy?: string,
 *   showAll?: boolean,
 *   onProgress?: (p: {phase: string} & Record<string, any>) => void,
 *   signal?: AbortSignal,
 *   candidateSource?: AsyncIterable<any>|Iterable<any>,
 *   fetchEntitiesFn?: (qids: string[]) => Promise<object>,
 *   fetchInatNamesFn?: (inatIds: string[]) => Promise<Map<string, {locale: string, name: string}[]>>,
 * }} opts
 * @returns {Promise<DiscoverNamesResult>}
 */
export async function discoverNames({
    store, taxaDb, scope = {}, limit = 5000, recheckAfter, seed = DEFAULT_SCAN_SEED,
    triggeredBy = 'manual', showAll = false,
    onProgress: report = () => {}, signal, candidateSource,
    fetchEntitiesFn = fetchEntities, fetchInatNamesFn = fetchInatNames,
}) {
    const iucn = resolveIucn(scope.iucn);
    // Resolved before the run row is opened: a bad scope should leave no trace of a run.
    const scoped = scope.taxon ? resolveTaxonScope(scope.taxon, taxaDb) : null;
    const scopedSet = scoped ? new Set(scoped.ids) : null;

    const runId = store.startRun('names', {
        iucn: iucn?.code ?? null, taxon: scope.taxon ?? null, limit, recheckAfter, showAll,
    }, triggeredBy);
    const onProgress = (p) => report({ runId, ...p });
    const result = { scanned: 0, open: 0, runId, cancelled: false };

    let failure = null;
    try {
        // Every status, not just settled ones — a taxon deliberately skipped must not resurface on
        // the next top-up, and a negative result only resurfaces once its recheck window has passed.
        const skip = store.skipQids(KIND, recheckAfter);

        onProgress({ phase: 'querying', limit, iucn: iucn?.code ?? null });
        const source = candidateSource ?? (iucn
            ? fetchWdNamesByIucn(iucn.qid)
            : fetchWdTaxaLinkedByInatIds(shuffle(taxaDb.allInatIds(), seed)));

        // Deduped by qid, not inatId: taxa/findings/skipQids() are all qid-keyed throughout the
        // DB, unlike the cache-names.json tombstone this replaces, which was inatId-keyed only
        // because that was the sole identity the by-inatId enumeration order naturally offered.
        const uncached = new Map(); // qid → {wdUri, qid, inatId, iucn}
        const seenQids = new Set();
        for await (const row of source) {
            if (seenQids.has(row.qid)) continue;
            seenQids.add(row.qid);
            if (skip.has(row.qid)) continue;
            if (scopedSet && !scopedSet.has(row.inatId)) continue;
            uncached.set(row.qid, {
                wdUri: row.wdUri, qid: row.qid, inatId: row.inatId,
                iucn: row.iucnQid ? IUCN_QID_TO_CODE[row.iucnQid] ?? null : null,
            });
            if (uncached.size >= limit) break;
            if (signal?.aborted) break;
        }
        result.scanned = uncached.size;
        onProgress({ phase: 'checking', taxa: uncached.size });
        if (uncached.size === 0 || signal?.aborted) return result;

        // P225 + P1843 for every candidate, one batched fetch.
        const entities = await fetchEntitiesFn([...uncached.keys()]);
        const wdData = new Map(); // qid → {taxonName, wdNames: Set<"locale:name">}
        for (const [qid, entity] of Object.entries(entities)) {
            // Real wbgetentities responses mark a merged/deleted entity with `missing: ''` (an
            // empty string, still falsy under formatversion=2 despite that param — confirmed live,
            // not assumed), so this must test presence of the key, not its truthiness. A truthy
            // check silently treats a gone entity as a normal empty one, which the diff below would
            // then happily "diff" against — recording a finding for a QID that no longer exists.
            if (entity.missing !== undefined) continue;
            const claims = simplify.claims(entity.claims || {}, { keepRichValues: true });
            const taxonName = claims.P225?.[0] ?? null;
            const wdNames = new Set(
                (claims.P1843 || []).map(v => {
                    // P1843 (vernacular name) is a monolingual-text claim; simplify.claims'
                    // SimplifiedClaim type is a wider union covering every datatype, since it can't
                    // know per-property which one applies.
                    const { language, text } = /** @type {{language: string, text: string}} */ (v);
                    return `${language}:${text.toLowerCase()}`;
                }));
            wdData.set(qid, { taxonName, wdNames });
        }
        if (signal?.aborted) { result.cancelled = true; return result; }

        // iNat vernacular names for every candidate.
        const inatNames = await fetchInatNamesFn([...uncached.values()].map(c => c.inatId));
        if (signal?.aborted) { result.cancelled = true; return result; }

        // Diff and record. The genus-leak filter and the case-insensitive locale:name comparison
        // are ported verbatim from checkNames.js; see docs/dev.md's "Genus-as-vernacular leak".
        for (const c of uncached.values()) {
            const wd = wdData.get(c.qid);
            if (!wd) continue; // gone/merged between candidate collection and the entity fetch
            if (!showAll && wd.wdNames.size > 0) continue;

            const inatEntries = inatNames.get(c.inatId) || [];
            const sciName = wd.taxonName?.toLowerCase();
            const sciGenus = sciName?.split(' ')[0];
            const missing = inatEntries.filter(({ locale, name }) => {
                const n = name.toLowerCase();
                return !wd.wdNames.has(`${locale}:${n}`) && n !== sciName && n !== sciGenus;
            });
            if (missing.length === 0) continue;

            store.upsertTaxon({ qid: c.qid, inatId: c.inatId, taxonName: wd.taxonName, iucn: c.iucn });
            store.recordFinding({ qid: c.qid, kind: KIND, status: 'open', payload: { missing } });
            result.open++;
        }
    } catch (err) {
        failure = err;
        throw err;
    } finally {
        store.finishRun(runId, {
            scanned: result.scanned, found: result.open,
            state: failure ? 'failed' : result.cancelled ? 'cancelled' : 'done',
            error: failure ? String(failure.code ?? 'run_failed') : null,
        });
    }

    onProgress({ phase: 'done', ...result });
    return result;
}
