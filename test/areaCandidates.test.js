// @ts-check
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fetchAreaCandidates } from '../lib/areaCandidates.js';

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
