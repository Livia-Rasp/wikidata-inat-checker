// @ts-check
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { inatBatches } from '../lib/getFromInat.js';

/** iNat matches by ancestry, so a queried genus counts when a species inside it has a photo. */
function fakePage(withPhotos, calls = []) {
    return async (taxonIds, _license, page) => {
        calls.push({ taxonIds: [...taxonIds], page });
        return {
            total_results: 1,
            results: taxonIds
                .filter(id => withPhotos.has(String(id)))
                .map(id => ({ taxon: { ancestor_ids: [Number(id)] } })),
        };
    };
}

/** 250 taxa is two batches at the 200-per-request ceiling. */
function manyTaxa(n) {
    return new Map(Array.from({ length: n }, (_, i) => [String(i + 1), `wd:Q${i + 1}`]));
}

/** The real limiter waits a second between requests; against a fake API that is just delay. */
const noWait = async () => {};

test('each batch is yielded as it completes, not collected to the end', async () => {
    const calls = [];
    const seen = [];
    for await (const b of inatBatches(manyTaxa(250), { fetchPage: fakePage(new Set(['1']), calls), rateLimit: noWait })) {
        // The point of the generator: by the time batch 1 is in hand, batch 2 has not been asked
        // for yet — which is what lets a caller record findings a killed run would otherwise lose.
        seen.push({ batch: b.batch, batches: b.batches, requests: calls.length });
    }
    assert.deepEqual(seen, [
        { batch: 1, batches: 2, requests: 1 },
        { batch: 2, batches: 2, requests: 2 },
    ]);
});

test('a batch reports what was asked as well as what was found', async () => {
    const [first] = await collect(inatBatches(manyTaxa(3), { fetchPage: fakePage(new Set(['2'])), rateLimit: noWait }));
    assert.deepEqual(first.available, { 'wd:Q2': true });
    assert.deepEqual(first.inatTaxonIds, { 'wd:Q2': '2' });
    // Without the full ask list the caller cannot record the negatives, which is most of a run.
    assert.deepEqual(first.wdUris, ['wd:Q1', 'wd:Q2', 'wd:Q3']);
    assert.deepEqual([...first.failed], []);
});

test('a failed batch is unanswered, not answered no — and does not stop the rest', async () => {
    let n = 0;
    const fetchPage = async (taxonIds) => {
        if (++n === 1) throw new Error('iNat HTTP 503');
        return { total_results: 1, results: taxonIds.map(id => ({ taxon: { ancestor_ids: [Number(id)] } })) };
    };

    const batches = await collect(inatBatches(manyTaxa(250), { fetchPage, rateLimit: noWait }));
    assert.equal(batches.length, 2, 'one bad batch must not abandon the run');
    assert.equal(batches[0].failed.size, 200);
    assert.deepEqual(batches[0].available, {}, 'nothing recorded for an unanswered batch');
    assert.equal(batches[1].failed.size, 0);
});

test('progress counts batches and running matches', async () => {
    const seen = [];
    await collect(inatBatches(manyTaxa(250), {
        fetchPage: fakePage(new Set(['1', '201'])),
        onProgress: (p) => seen.push(p),
        rateLimit: noWait,
    }));
    assert.deepEqual(seen, [
        { batch: 1, batches: 2, matched: 1 },
        { batch: 2, batches: 2, matched: 2 },
    ]);
});

async function collect(iter) {
    const out = [];
    for await (const x of iter) out.push(x);
    return out;
}
