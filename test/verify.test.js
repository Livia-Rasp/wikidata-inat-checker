// @ts-check
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { createFindingsStore, migrate } from '../lib/db.js';
import { verifyOpenFindings } from '../lib/verify.js';

function makeStore() {
    const db = new DatabaseSync(':memory:');
    migrate(db);
    return { db, store: createFindingsStore(db) };
}

function seedOpen(store, qid, wikitext = `{{Species|Taxon ${qid}|}}`) {
    store.upsertTaxon({ qid, inatId: `inat-${qid}`, taxonName: `Taxon ${qid}`, iucn: 'VU' });
    store.recordFinding({ qid, kind: 'image', status: 'open', payload: { wikitext } });
}

/**
 * A fake wbgetentities. `spec` maps QID → 'hasImage' | 'noImage' | 'missing'.
 * Records the batches it was asked for, so batching itself can be asserted.
 */
function fakeApi(spec, calls = []) {
    return async (qids) => {
        calls.push(qids);
        const entities = {};
        for (const qid of qids) {
            const kind = spec[qid] ?? 'noImage';
            if (kind === 'missing') { entities[qid] = { id: qid, missing: '' }; continue; }
            entities[qid] = {
                id: qid,
                claims: kind === 'hasImage'
                    ? { P18: [{ mainsnak: { datavalue: { value: 'Lion.jpg', type: 'string' } } }] }
                    : {},
                sitelinks: {},
            };
        }
        return { entities, success: 1 };
    };
}

test('a P18 that appeared upstream resolves the finding', async () => {
    const { db, store } = makeStore();
    seedOpen(store, 'Q1');

    const res = await verifyOpenFindings(store, { fetchFn: fakeApi({ Q1: 'hasImage' }) });

    assert.deepEqual(res.fixedUpstream, ['Q1']);
    const row = db.prepare("SELECT status, resolved_at, resolution FROM findings WHERE qid='Q1'").get();
    assert.equal(row.status, 'fixed_upstream');
    assert.ok(row.resolved_at, 'resolved_at is stamped');
    assert.equal(JSON.parse(row.resolution).file, 'Lion.jpg', 'the image that fixed it is recorded');
});

test('a still-imageless finding stays open but records that we looked', async () => {
    const { db, store } = makeStore();
    seedOpen(store, 'Q1');
    const before = db.prepare("SELECT verified_at FROM findings WHERE qid='Q1'").get().verified_at;
    assert.equal(before, null, 'nothing has verified it yet');

    const res = await verifyOpenFindings(store, { fetchFn: fakeApi({ Q1: 'noImage' }) });

    assert.equal(res.stillOpen, 1);
    const row = db.prepare("SELECT status, verified_at, resolved_at FROM findings WHERE qid='Q1'").get();
    assert.equal(row.status, 'open');
    assert.ok(row.verified_at, 'verified_at moves');
    assert.equal(row.resolved_at, null, 'nothing was resolved');
});

test('a deleted or merged item becomes gone', async () => {
    const { db, store } = makeStore();
    seedOpen(store, 'Q1');

    const res = await verifyOpenFindings(store, { fetchFn: fakeApi({ Q1: 'missing' }) });

    assert.deepEqual(res.gone, ['Q1']);
    assert.equal(db.prepare("SELECT status FROM findings WHERE qid='Q1'").get().status, 'gone');
});

test('an entity absent from the response is treated as gone, not skipped', async () => {
    const { db, store } = makeStore();
    seedOpen(store, 'Q1');
    // An API that answers without mentioning the item at all.
    const res = await verifyOpenFindings(store, { fetchFn: async () => ({ entities: {}, success: 1 }) });

    assert.deepEqual(res.gone, ['Q1'], 'must not leave the finding silently stuck open');
    assert.equal(db.prepare("SELECT status FROM findings WHERE qid='Q1'").get().status, 'gone');
});

test('verification never destroys the stored draft wikitext', async () => {
    const { db, store } = makeStore();
    seedOpen(store, 'Q1', '{{Species|Panthera onca|}}');   // resolved
    seedOpen(store, 'Q2', '{{Species|Panthera leo|}}');    // stays open

    await verifyOpenFindings(store, { fetchFn: fakeApi({ Q1: 'hasImage', Q2: 'noImage' }) });

    // The trap: recordFinding() would have overwritten payload with NULL here.
    for (const qid of ['Q1', 'Q2']) {
        const payload = db.prepare('SELECT payload FROM findings WHERE qid = ?').get(qid).payload;
        assert.ok(payload, `${qid} still has a payload`);
        assert.match(JSON.parse(payload).wikitext, /^\{\{Species\|Panthera /);
    }
});

test('a resolved finding leaves the worklist but is never rediscovered', async () => {
    const { store } = makeStore();
    seedOpen(store, 'Q1');
    seedOpen(store, 'Q2');

    await verifyOpenFindings(store, { fetchFn: fakeApi({ Q1: 'hasImage', Q2: 'noImage' }) });

    assert.deepEqual(store.openFindings('image').map(f => f.qid), ['Q2'],
        'the fixed one is off the worklist');
    assert.ok(store.skipQids('image').has('Q1'),
        'but discovery must still skip it — fixed_upstream is settled, not forgotten');
});

test('requests are chunked to the API ceiling of 50 ids', async () => {
    const { store } = makeStore();
    for (let i = 1; i <= 120; i++) seedOpen(store, `Q${i}`);

    const calls = [];
    await verifyOpenFindings(store, { fetchFn: fakeApi({}, calls) });

    assert.equal(calls.length, 3, '120 ids → 3 requests');
    assert.deepEqual(calls.map(c => c.length), [50, 50, 20]);
    assert.ok(calls.every(c => c.length <= 50));
});

test('--limit caps how much of the backlog one pass verifies', async () => {
    const { store } = makeStore();
    for (let i = 1; i <= 10; i++) seedOpen(store, `Q${i}`);

    // Rows share a discovered_at here, so openFindings falls back to its qid tiebreak; take the
    // order from the store rather than assuming it, since only the count and the prefix matter.
    const expected = store.openFindings('image').slice(0, 4).map(f => f.qid);

    const calls = [];
    const res = await verifyOpenFindings(store, { limit: 4, fetchFn: fakeApi({}, calls) });

    assert.equal(res.verified, 4);
    assert.deepEqual(calls, [expected], 'one request, for the first four of the backlog');
    assert.equal(store.openFindings('image').length, 10, 'the other six are untouched, still open');
});

test('verifying an empty backlog makes no requests at all', async () => {
    const { store } = makeStore();
    const calls = [];
    const res = await verifyOpenFindings(store, { fetchFn: fakeApi({}, calls) });

    assert.equal(res.verified, 0);
    assert.equal(calls.length, 0);
});
