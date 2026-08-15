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

const rateLimit = createRateLimiter();

async function processBatch(batch, license) {
    const taxonIds = batch.map(([k]) => k);
    const idToWd = new Map(batch);
    const querySet = new Set(taxonIds.map(String));

    const matched = new Set();
    let page = 1;
    while (true) {
        await rateLimit();
        const data = await fetchBatchPage(taxonIds, license, page);
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
 * Queries iNat /v1/observations/species_counts for taxa in `map`, returning those
 * with at least one research-grade photo under an accepted license.
 * @param {Map<string, string>} map - iNat taxon ID → Wikidata URI
 * @param {string} [license]
 * @returns {Promise<InatResult>}
 */
export async function processInatIds(map, license = DEFAULT_LICENSE) {
    const todo = [...map];
    console.log(`Querying ${todo.length} taxa against iNat...`);

    const batches = [];
    for (let i = 0; i < todo.length; i += BATCH_SIZE) {
        batches.push(todo.slice(i, i + BATCH_SIZE));
    }

    const available = {};
    const inatTaxonIds = {};
    const failed = new Set();
    let totalMatched = 0;

    for (let i = 0; i < batches.length; i++) {
        try {
            const results = await processBatch(batches[i], license);
            for (const { wdUri, taxonId } of results) {
                available[wdUri] = true;
                inatTaxonIds[wdUri] = taxonId;
            }
            totalMatched += results.length;
        } catch (error) {
            console.error('batch', i + 1, 'error:', error.message);
            // The whole batch is unanswered, not answered "no" — mark every taxon in it so the
            // caller records nothing and they are retried on the next run.
            for (const [, wdUri] of batches[i]) failed.add(wdUri);
        }
        if ((i + 1) % 5 === 0 || i === batches.length - 1) {
            console.log(`progress: batch ${i + 1}/${batches.length}, available so far: ${totalMatched}`);
        }
    }

    if (failed.size > 0) console.warn(`iNat: ${failed.size} taxa unanswered (batch errors) — not recorded, will retry.`);
    return { available, inatTaxonIds, failed };
}
