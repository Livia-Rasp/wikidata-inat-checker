// @ts-check
import { createRateLimiter, reqInit } from './utils.js';

/**
 * `failed` holds the Wikidata URIs whose iNat batch errored, so the caller can tell "asked, found
 * nothing" from "never got an answer". That distinction did not matter when results went into a
 * disposable cache; with a persistent findings store, recording a failed request as "no photos"
 * would write the taxon off until the recheck window expires.
 * @typedef {{ available: Record<string, true>, inatTaxonIds: Record<string, string>, failed: Set<string> }} InatResult
 */

const BATCH_SIZE = 200;
const PER_PAGE = 500;
const API_URL = 'https://api.inaturalist.org/v1/observations/species_counts';
const DEFAULT_LICENSE = 'cc0,cc-by,cc-by-sa';

async function fetchBatchPage(taxonIds, license, page) {
    const q = new URLSearchParams({
        taxon_id: taxonIds.join(','),
        photo_license: license,
        quality_grade: 'research',
        per_page: String(PER_PAGE),
        page: String(page)
    });
    // Identified and time-bounded: this is the bulk of a discovery run's iNat traffic, and it went
    // out anonymously with no timeout until slice 5 made runs remotely triggerable.
    const r = await fetch(API_URL + '?' + q, reqInit());
    if (!r.ok) throw new Error(`iNat HTTP ${r.status}`);
    return r.json();
}

/** One instance per process: iNat asks for ≤60 requests/minute and this is most of our traffic. */
const defaultRateLimit = createRateLimiter();

async function processBatch(batch, license, fetchPage, rateLimit) {
    const taxonIds = batch.map(([k]) => k);
    const idToWd = new Map(batch);
    const querySet = new Set(taxonIds.map(String));

    const matched = new Set();
    let page = 1;
    while (true) {
        await rateLimit();
        const data = await fetchPage(taxonIds, license, page);
        for (const r of data.results || []) {
            for (const anc of r.taxon.ancestor_ids || []) {
                const s = String(anc);
                if (querySet.has(s)) matched.add(s);
            }
        }
        if (page * PER_PAGE >= (data.total_results || 0)) break;
        page++;
    }

    return [...matched].map(taxonId => ({ wdUri: idToWd.get(taxonId), taxonId }));
}

/**
 * Queries iNat /v1/observations/species_counts for taxa in `map`, yielding **one result per
 * batch as it completes** rather than one result for the lot.
 *
 * A whole pass takes minutes at the 1 req/s the limiter imposes. Collecting it all and returning
 * at the end meant a run that was killed — or simply watched — had nothing to show for the work
 * already paid for in API budget. The caller records each batch as it arrives instead.
 *
 * `wdUris` on each batch is every taxon asked about, so a caller can record the negatives too;
 * `failed` non-empty means the batch was unanswered rather than answered "no".
 *
 * @param {Map<string, string>} map - iNat taxon ID → Wikidata URI
 * @param {{license?: string, onProgress?: (p: {batch: number, batches: number, matched: number}) => void,
 *          fetchPage?: (ids: string[], license: string, page: number) => Promise<any>,
 *          rateLimit?: () => Promise<void>}} [opts]
 * @returns {AsyncGenerator<InatResult & {wdUris: string[], batch: number, batches: number}>}
 */
export async function* inatBatches(map, opts = {}) {
    const {
        license = DEFAULT_LICENSE, onProgress,
        fetchPage = fetchBatchPage,
        // Injectable with fetchPage: waiting a real second between fake requests buys nothing.
        rateLimit = defaultRateLimit,
    } = opts;
    const todo = [...map];

    const batches = [];
    for (let i = 0; i < todo.length; i += BATCH_SIZE) {
        batches.push(todo.slice(i, i + BATCH_SIZE));
    }

    let totalMatched = 0;
    for (let i = 0; i < batches.length; i++) {
        const available = {};
        const inatTaxonIds = {};
        const failed = new Set();
        try {
            for (const { wdUri, taxonId } of await processBatch(batches[i], license, fetchPage, rateLimit)) {
                available[wdUri] = true;
                inatTaxonIds[wdUri] = taxonId;
                totalMatched++;
            }
        } catch (error) {
            // The whole batch is unanswered, not answered "no" — mark every taxon in it so the
            // caller records nothing and they are retried on the next run.
            for (const [, wdUri] of batches[i]) failed.add(wdUri);
        }
        onProgress?.({ batch: i + 1, batches: batches.length, matched: totalMatched });
        yield {
            available, inatTaxonIds, failed,
            wdUris: batches[i].map(([, wdUri]) => wdUri),
            batch: i + 1, batches: batches.length,
        };
    }
}

/**
 * The whole pass at once, for callers that genuinely want it collected.
 * @param {Map<string, string>} map - iNat taxon ID → Wikidata URI
 * @param {string} [license]
 * @returns {Promise<InatResult>}
 */
export async function processInatIds(map, license = DEFAULT_LICENSE) {
    console.log(`Querying ${map.size} taxa against iNat...`);
    const available = {};
    const inatTaxonIds = {};
    const failed = new Set();

    const onProgress = ({ batch, batches, matched }) => {
        if (batch % 5 === 0 || batch === batches) {
            console.log(`progress: batch ${batch}/${batches}, available so far: ${matched}`);
        }
    };
    for await (const b of inatBatches(map, { license, onProgress })) {
        Object.assign(available, b.available);
        Object.assign(inatTaxonIds, b.inatTaxonIds);
        for (const wdUri of b.failed) failed.add(wdUri);
    }

    if (failed.size > 0) console.warn(`iNat: ${failed.size} taxa unanswered (batch errors) — not recorded, will retry.`);
    return { available, inatTaxonIds, failed };
}
