// @ts-check
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fetchAreaCandidates, fetchAreaEnrichment, fetchAreaSpecies } from '../lib/areaCandidates.js';

const noWait = async () => {};
const AREA = { lat: 48.147, lng: 11.589, radius: 10 };

/** A single-page iNat species_counts response for the given taxa. */
function onePage(taxa) {
    return async () => ({
        total_results: taxa.length,
        results: taxa.map(({ id, name, commonName, count }) => ({
            taxon: { id, name, preferred_common_name: commonName ?? '' },
            count,
        })),
    });
}

/** A candidate source stub shaped like fetchWdTaxaByInatIds's own output. */
function candidatesFor(ids) {
    return async function* gen(requested) {
        for (const id of requested) {
            if (!ids.includes(id)) continue;
            yield { wdUri: `http://www.wikidata.org/entity/Q${id}`, qid: `Q${id}`, inatId: id, iucnQid: null };
        }
    };
}

test('candidates carry the iNat metadata alongside the Wikidata row', async () => {
    const getJsonFn = onePage([
        { id: 1, name: 'Species one', commonName: 'One-flower', count: 5 },
        { id: 2, name: 'Species two', commonName: '', count: 12 },
    ]);
    const out = [];
    for await (const row of fetchAreaCandidates(AREA, {
        inatLimiter: noWait, getJsonFn, candidatesFn: candidatesFor(['1', '2']),
    })) out.push(row);

    assert.deepEqual(out, [
        { wdUri: 'http://www.wikidata.org/entity/Q1', qid: 'Q1', inatId: '1', iucnQid: null,
            taxonName: 'Species one', commonName: 'One-flower', count: 5 },
        { wdUri: 'http://www.wikidata.org/entity/Q2', qid: 'Q2', inatId: '2', iucnQid: null,
            taxonName: 'Species two', commonName: '', count: 12 },
    ]);
});

test('a species with no matching Wikidata candidate is never yielded', async () => {
    const getJsonFn = onePage([
        { id: 1, name: 'Has a Wikidata item', count: 1 },
        { id: 2, name: 'No Wikidata item at all', count: 1 },
    ]);
    const out = [];
    // Only id 1 has a candidate — id 2 is a real iNat species with no matching P3151 item, or one
    // that already has an image, so the SPARQL step never yields it.
    for await (const row of fetchAreaCandidates(AREA, {
        inatLimiter: noWait, getJsonFn, candidatesFn: candidatesFor(['1']),
    })) out.push(row);

    assert.equal(out.length, 1);
    assert.equal(out[0].inatId, '1');
});

// ---- fetchAreaEnrichment: the fix for the shared-window starvation bug ----

test('every taxon gets its own photos and date, never starved by a batchmate', async () => {
    // The old batched shape (`taxon_id=id1,id2,...id20`) returned one fixed-size window shared
    // across the whole batch, ordered globally — so a taxon that never won that ordering came back
    // empty even though it had qualifying observations. A per-taxon fetch has nothing to share, so
    // this stub deliberately gives every one of 25 taxa its own real observation: if the fix
    // regressed to a shared window, taxa past the old window's size (60 for photos, 20 for dates)
    // would come back empty here.
    const taxonIds = Array.from({ length: 25 }, (_, i) => String(i + 1));
    const getJsonFn = async (url) => {
        const taxonId = new URL(url, 'http://x').searchParams.get('taxon_id');
        return {
            results: [{
                observed_on: `2026-0${(Number(taxonId) % 9) + 1}-01`,
                photos: [{ url: 'https://example.com/square.jpg' }],
                id: Number(taxonId) * 1000,
            }],
        };
    };
    const { obsMap, latestDateMap } = await fetchAreaEnrichment(taxonIds, AREA, {
        inatLimiter: noWait, getJsonFn,
    });

    for (const taxonId of taxonIds) {
        assert.ok(latestDateMap.has(taxonId), `taxon ${taxonId} got a date`);
        assert.ok(obsMap.has(taxonId), `taxon ${taxonId} got a photo`);
    }
    assert.equal(latestDateMap.size, 25);
    assert.equal(obsMap.size, 25);
});

test('a taxon with no qualifying observations gets neither a date nor a photo, not a crash', async () => {
    const getJsonFn = async () => ({ results: [] });
    const { obsMap, latestDateMap } = await fetchAreaEnrichment(['1'], AREA, {
        inatLimiter: noWait, getJsonFn,
    });
    assert.equal(obsMap.has('1'), false);
    assert.equal(latestDateMap.has('1'), false);
});

test('at most 3 photos per taxon, and the square thumbnail is upgraded to small', async () => {
    const getJsonFn = async () => ({
        results: Array.from({ length: 5 }, (_, i) => ({
            observed_on: '2026-01-01',
            id: i,
            photos: [{ url: 'https://example.com/photos/1/square.jpg' }],
        })),
    });
    const { obsMap } = await fetchAreaEnrichment(['1'], AREA, { inatLimiter: noWait, getJsonFn });
    const photos = obsMap.get('1');
    assert.equal(photos.length, 3);
    assert.ok(photos.every((p) => p.photoUrl.includes('/small.jpg')));
});

test('species_counts is paginated until the page is short or the total is reached', async () => {
    let calls = 0;
    const getJsonFn = async (url) => {
        calls++;
        const page = Number(new URL(url, 'http://x').searchParams.get('page'));
        if (page === 1) {
            return { total_results: 3, results: [{ taxon: { id: 1, name: 'A' }, count: 1 }] };
        }
        return { total_results: 3, results: [
            { taxon: { id: 2, name: 'B' }, count: 1 },
            { taxon: { id: 3, name: 'C' }, count: 1 },
        ] };
    };
    const out = [];
    for await (const row of fetchAreaCandidates(AREA, {
        inatLimiter: noWait, getJsonFn, candidatesFn: candidatesFor(['1', '2', '3']),
    })) out.push(row);

    assert.equal(calls, 2, 'stopped once every species had been fetched');
    assert.deepEqual(out.map((r) => r.inatId).sort(), ['1', '2', '3']);
});

test('maxPages bounds Step 1 independent of how much more there is to fetch', async () => {
    let calls = 0;
    // An endpoint that always has another page — without a bound this would paginate forever.
    const getJsonFn = async (url) => {
        calls++;
        const page = Number(new URL(url, 'http://x').searchParams.get('page'));
        return {
            total_results: 999999,
            results: [{ taxon: { id: page, name: `Species ${page}` }, count: 1 }],
        };
    };
    const species = await fetchAreaSpecies(AREA, { inatLimiter: noWait, getJsonFn, maxPages: 3 });

    assert.equal(calls, 3);
    assert.equal(species.size, 3);
});
