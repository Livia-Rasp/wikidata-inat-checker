// @ts-check
// Discovery: find Wikidata taxa that have an iNaturalist ID but no image, and record what we learn
// about each one. Extracted from checkImages.js so the same work can be triggered by the CLI or by
// the server, which runs it in a forked child (docs/dev.md).
//
// Two properties matter more here than they did in the CLI:
//
//   - **Outcomes are recorded batch by batch.** A run is minutes long and spends Wikimedia and
//     iNaturalist budget the whole time; collecting everything and writing at the end meant a run
//     that was killed, cancelled or crashed had nothing to show for it.
//   - **Bad input throws.** The CLI called process.exit on an unknown taxon or IUCN code. Reached
//     over HTTP that is an unauthenticated remote kill, so these are typed errors the caller turns
//     into a 400.
import { inatBatches } from './getFromInat.js';
import { generateDraftWikitext, createWikitextContext } from './generateWikitext.js';
import { extractTaxonName } from '../report/htmlShared.js';
import { fetchWdTaxaByInatIds, fetchWdImagesByIucn, IUCN_STATUS_QIDS, IUCN_QID_TO_CODE, shuffle, DEFAULT_SCAN_SEED } from './utils.js';
import { resolveAreaScope, fetchAreaCandidates } from './areaCandidates.js';
import { AppError } from './errors.js';

export const KIND = 'image';

/** A scope the caller got wrong, carrying enough detail to say what to do instead. A bad scope is
 *  the caller's mistake, not a defect: `runMain` prints the message without a stack trace, and
 *  the route layer turns it into a 400 rather than a 500. */
export class DiscoveryError extends AppError {
    /** @param {string} code @param {string} message @param {Record<string, any>} [details] */
    constructor(code, message, details = {}) {
        super(message);
        this.code = code;
        this.details = details;
    }

    /** Lines a CLI should print under the message — the candidates, when a name was ambiguous. */
    get hints() {
        return (this.details.matches ?? []).map((m) => `${m.inatId}  (${m.rank})`);
    }
}

/**
 * Resolve an iNat ID or a name to a single taxon id.
 *
 * The `^\d+$` test is load-bearing beyond parsing: `descendantInatIds` interpolates the id into
 * LIKE patterns, so a `%` would match every row in a 3M-row table and turn one request into
 * hundreds of SPARQL queries. Callers that never scan descendants must keep the test anyway —
 * it is the guard, and there is one input validator, not one per caller.
 *
 * Split out from {@link resolveTaxonScope} so the search route can name a clade without paying
 * for its descendant set: the name lookup is an indexed read, the scan is half a second.
 *
 * @param {string} arg
 * @param {{getAll: Function}} taxaDb
 * @returns {string}
 */
export function resolveTaxonId(arg, taxaDb) {
    if (/^\d+$/.test(arg)) return arg;
    const matches = taxaDb.getAll(arg);
    if (matches.length === 0) {
        throw new DiscoveryError('unknown_taxon', `Taxon "${arg}" is not in the iNat taxa index.`);
    }
    if (matches.length > 1) {
        throw new DiscoveryError('ambiguous_taxon',
            `Taxon "${arg}" is ambiguous (${matches.length} matches) — use the iNat ID.`,
            { matches: matches.map(m => ({ inatId: m.inatId, rank: m.rank })) });
    }
    return matches[0].inatId;
}

/**
 * Resolve a taxon scope (an iNat ID or a name) to the taxon plus all its descendants.
 *
 * @param {string} arg
 * @param {{getAll: Function, descendantInatIds: Function}} taxaDb
 * @returns {{taxonId: string, ids: string[]}}
 */
export function resolveTaxonScope(arg, taxaDb) {
    const taxonId = resolveTaxonId(arg, taxaDb);
    return { taxonId, ids: [taxonId, ...taxaDb.descendantInatIds(taxonId)] };
}

/** @param {string|null|undefined} code */
export function resolveIucn(code) {
    if (!code) return null;
    const upper = String(code).toUpperCase();
    // Own-property only: a plain object literal would answer `constructor` with a function.
    if (!Object.hasOwn(IUCN_STATUS_QIDS, upper)) {
        throw new DiscoveryError('unknown_iucn',
            `Unknown IUCN status "${code}". Valid codes: ${Object.keys(IUCN_STATUS_QIDS).join(', ')}`);
    }
    return { code: upper, qid: IUCN_STATUS_QIDS[upper] };
}

/**
 * Wrap a progress reporter with the run id every event should carry — what a caller needs to
 * cancel *this* run rather than whichever one happens to be going when the request lands.
 * Identical across all three discovery pipelines.
 * @param {(p: {phase: string} & Record<string, any>) => void} report
 * @param {number} runId
 * @returns {(p: {phase: string} & Record<string, any>) => void}
 */
export function runProgress(report, runId) {
    return (p) => report({ runId, ...p });
}

/**
 * The run row's outcome fields for `store.finishRun`, shared by all three discovery pipelines.
 * The state says what became of the run, not merely that it stopped — a cancelled run must not
 * misreport a partial top-up as a complete one. `error` is a code the caller chose, never a raw
 * message: node:sqlite errors carry absolute paths.
 * @param {any} failure
 * @param {boolean} cancelled
 * @returns {{state: 'failed'|'cancelled'|'done', error: string|null}}
 */
export function runFinishFields(failure, cancelled) {
    return {
        state: failure ? 'failed' : cancelled ? 'cancelled' : 'done',
        error: failure ? String(failure.code ?? 'run_failed') : null,
    };
}

/**
 * @typedef {{scanned: number, open: number, noDraft: number, noPhotos: number, failed: number,
 *            alreadyKnown: number, runId: number, cancelled: boolean}} DiscoverResult
 */

/**
 * @param {{
 *   store: any, taxaDb: any,
 *   scope?: {taxon?: string|null, iucn?: string|null, lat?: number|null, lng?: number|null, radius?: number|null},
 *   limit?: number, recheckAfter?: number, seed?: number, triggeredBy?: string,
 *   onProgress?: (p: {phase: string} & Record<string, any>) => void,
 *   signal?: AbortSignal,
 *   inatOptions?: object,
 *   candidateSource?: AsyncIterable<any>|Iterable<any>,
 *   generateDrafts?: (available: Record<string, true>, opts: object) => Promise<Record<string, string>>,
 *   log?: {warn: Function},
 * }} opts
 * @returns {Promise<DiscoverResult>}
 */
export async function discover({
    store, taxaDb, scope = {}, limit = 5000, recheckAfter, seed = DEFAULT_SCAN_SEED,
    triggeredBy = 'manual', onProgress: report = () => {}, signal, inatOptions = {},
    candidateSource, generateDrafts = generateDraftWikitext, log = console,
}) {
    const iucn = resolveIucn(scope.iucn);
    // Resolved before the run row is opened: a bad scope should leave no trace of a run.
    const scoped = scope.taxon ? resolveTaxonScope(scope.taxon, taxaDb) : null;
    const area = resolveAreaScope(scope);

    const runId = store.startRun('images', {
        iucn: iucn?.code ?? null, taxon: scope.taxon ?? null, limit, recheckAfter,
        lat: area?.lat ?? null, lng: area?.lng ?? null, radius: area?.radius ?? null,
    }, triggeredBy);
    const onProgress = runProgress(report, runId);
    const result = {
        scanned: 0, open: 0, noDraft: 0, noPhotos: 0, failed: 0,
        alreadyKnown: 0, runId, cancelled: false,
    };

    let failure = null;
    try {
        if (scoped) {
            onProgress({ phase: 'scope', taxon: scope.taxon, taxonId: scoped.taxonId, taxa: scoped.ids.length });
        }

        // Taxa to leave alone: anything settled, plus negatives still inside the recheck window.
        // Every status, not just `open` — skipping only the open ones would resurface every taxon
        // deliberately passed over on the next top-up.
        const skip = store.skipQids(KIND, recheckAfter);
        const scopedSet = scoped ? new Set(scoped.ids) : null;

        onProgress({ phase: 'querying', limit, iucn: iucn?.code ?? null });
        // Every scope reduces to the same thing: a stream of candidate rows. Slice 6's area scope
        // is a third source over this same tail, not a third branch through it.
        // Shuffled: allInatIds() (and a scoped clade's descendant list) come back in whatever
        // incidental order their source emits them, so an unshuffled --limit run would always
        // hit the same early slice first. The IUCN and area branches need no shuffle — both query
        // an already-selective matching set (WDQS directly, or the area's own species list) rather
        // than enumerating the whole taxa index by id.
        const source = candidateSource ?? (iucn
            ? fetchWdImagesByIucn(iucn.qid, { log })
            : area
              ? fetchAreaCandidates(area, { log })
              : fetchWdTaxaByInatIds(shuffle(scoped?.ids ?? taxaDb.allInatIds(), seed), { log }));

        const uncached = new Map(); // iNat ID → Wikidata URI
        const meta = new Map();     // Wikidata URI → { qid, inatId, iucn }
        const seenIds = new Set();
        for await (const row of source) {
            // The IUCN path queries Wikidata directly, so apply the taxon scope here.
            if (scopedSet && !scopedSet.has(row.inatId)) continue;
            if (seenIds.has(row.inatId)) continue;
            seenIds.add(row.inatId);
            if (skip.has(row.qid)) { result.alreadyKnown++; continue; }
            uncached.set(row.inatId, row.wdUri);
            meta.set(row.wdUri, {
                qid: row.qid,
                inatId: row.inatId,
                iucn: row.iucnQid ? IUCN_QID_TO_CODE[row.iucnQid] ?? null : null,
            });
            if (uncached.size >= limit) break;
            if (signal?.aborted) break;
        }
        result.scanned = meta.size;
        onProgress({ phase: 'checking', taxa: uncached.size, alreadyKnown: result.alreadyKnown });

        // One context for the whole run: taxa share their upper lineage, and the Commons template
        // map costs 10-40 requests, so per-batch generation must not start from scratch each time.
        const context = createWikitextContext();

        for await (const batch of inatBatches(uncached, {
            ...inatOptions,
            onProgress: (p) => onProgress({ phase: 'checking', ...p }),
        })) {
            const drafts = await generateDrafts(batch.available, { context, log: () => {} });
            recordBatch(store, batch, meta, drafts, result);
            onProgress({
                phase: 'recording', batch: batch.batch, batches: batch.batches,
                open: result.open, noPhotos: result.noPhotos, noDraft: result.noDraft,
            });
            if (signal?.aborted) { result.cancelled = true; break; }
        }
    } catch (err) {
        failure = err;
        throw err;
    } finally {
        // The run row says what became of it, not merely that it stopped. A cancelled run that
        // recorded itself as `done` would misreport a partial top-up as a complete one.
        store.finishRun(runId, {
            scanned: result.scanned,
            found: result.open,
            ...runFinishFields(failure, result.cancelled),
        });
    }

    onProgress({ phase: 'done', ...result });
    return result;
}

/**
 * Record one batch's outcomes:
 *   photos + a draft  → open        (the actionable backlog)
 *   photos, no draft  → no_draft    (no P225 / no family template — still fixable by hand)
 *   no photos         → no_photos   (expires, see recheckAfter)
 *   batch errored     → nothing at all, so the taxon is retried next run
 */
function recordBatch(store, batch, meta, drafts, result) {
    for (const wdUri of batch.wdUris) {
        if (batch.failed.has(wdUri)) { result.failed++; continue; }
        const m = meta.get(wdUri);
        if (!m) continue;

        const wikitext = drafts[wdUri];
        const hasPhotos = Boolean(batch.available[wdUri]);
        const status = !hasPhotos ? 'no_photos' : wikitext ? 'open' : 'no_draft';

        store.upsertTaxon({
            qid: m.qid,
            inatId: batch.inatTaxonIds[wdUri] ?? m.inatId,
            taxonName: wikitext ? extractTaxonName(wikitext) : null,
            iucn: m.iucn,
        });
        store.recordFinding({ qid: m.qid, kind: KIND, status, payload: wikitext ? { wikitext } : undefined });

        if (status === 'open') result.open++;
        else if (status === 'no_draft') result.noDraft++;
        else result.noPhotos++;
    }
}
