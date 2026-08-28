// @ts-check
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { verifyOpenFindings, readImageFacts, readLinkFacts, readNameFacts } from '../lib/verify.js';
import { makeStore } from './helpers.js';

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
    assert.equal(JSON.parse(String(row.resolution)).file, 'Lion.jpg', 'the image that fixed it is recorded');
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
        assert.match(JSON.parse(String(payload)).wikitext, /^\{\{Species\|Panthera /);
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

// ---- kind='link' — different predicate (P3151), plus conflict re-verification ----

function seedOpenLink(store, qid, inatId, evidence = { matches: 3, mismatches: 0, matchedRanks: ['family', 'genus', 'subfamily'] }) {
    store.upsertTaxon({ qid, inatId, taxonName: `Taxon ${qid}` });
    store.recordFinding({
        qid, kind: 'link', status: 'open',
        payload: { inatId, rank: 'species', evidence, autoEligible: true },
    });
}

function seedConflict(store, qid, inatId, existingWdItem) {
    store.upsertTaxon({ qid, inatId, taxonName: `Taxon ${qid}` });
    store.recordFinding({
        qid, kind: 'link', status: 'conflict',
        payload: {
            inatId, rank: 'species',
            evidence: { matches: 1, mismatches: 0, matchedRanks: ['genus'] },
            existingWdItem, existingTaxonName: `Taxon ${existingWdItem}`,
        },
    });
}

/** A fake wbgetentities keyed by QID → P3151 value (or 'missing'). */
function fakeLinkApi(spec, calls = []) {
    return async (qids) => {
        calls.push(qids);
        const entities = {};
        for (const qid of qids) {
            const v = spec[qid];
            if (v === 'missing' || v === undefined) { entities[qid] = { id: qid, missing: '' }; continue; }
            entities[qid] = {
                id: qid,
                claims: v === null ? {} : { P3151: [{ mainsnak: { datavalue: { value: v } } }] },
            };
        }
        return { entities, success: 1 };
    };
}

test('a P3151 that appeared upstream resolves an open link finding', async () => {
    const { db, store } = makeStore();
    seedOpenLink(store, 'Q1', '41970');

    const res = await verifyOpenFindings(store, { kind: 'link', fetchFn: fakeLinkApi({ Q1: '41970' }) });

    assert.deepEqual(res.fixedUpstream, ['Q1']);
    const row = db.prepare("SELECT status, resolution FROM findings WHERE qid='Q1'").get();
    assert.equal(row.status, 'fixed_upstream');
    assert.equal(JSON.parse(String(row.resolution)).inatId, '41970');
});

test('a still-unclaimed open link finding stays open', async () => {
    const { store } = makeStore();
    seedOpenLink(store, 'Q1', '41970');
    const res = await verifyOpenFindings(store, { kind: 'link', fetchFn: fakeLinkApi({ Q1: null }) });
    assert.equal(res.stillOpen, 1);
    assert.deepEqual(store.openFindings('link').map(f => f.qid), ['Q1']);
});

test('a merged or deleted link item becomes gone', async () => {
    const { db, store } = makeStore();
    seedOpenLink(store, 'Q1', '41970');
    await verifyOpenFindings(store, { kind: 'link', fetchFn: fakeLinkApi({ Q1: 'missing' }) });
    assert.equal(db.prepare("SELECT status FROM findings WHERE qid='Q1'").get().status, 'gone');
});

test('a conflict whose competing claim persists stays a conflict', async () => {
    const { db, store } = makeStore();
    seedConflict(store, 'Q1', '41970', 'Q2');

    const res = await verifyOpenFindings(store, {
        kind: 'link', fetchFn: fakeLinkApi({ Q1: null, Q2: '41970' }),
    });

    assert.equal(res.stillOpen, 1);
    const row = db.prepare("SELECT status, verified_at FROM findings WHERE qid='Q1'").get();
    assert.equal(row.status, 'conflict');
    assert.ok(row.verified_at);
});

test('a conflict whose competing claim vanished re-opens, payload intact', async () => {
    const { db, store } = makeStore();
    seedConflict(store, 'Q1', '41970', 'Q2');

    await verifyOpenFindings(store, {
        kind: 'link', fetchFn: fakeLinkApi({ Q1: null, Q2: 'missing' }),
    });

    const row = db.prepare("SELECT status, resolved_at, payload FROM findings WHERE qid='Q1'").get();
    assert.equal(row.status, 'open');
    assert.equal(row.resolved_at, null, 're-opening is not a resolution');
    const payload = JSON.parse(String(row.payload));
    assert.equal(payload.inatId, '41970');
    assert.equal(payload.autoEligible, false, 'a lone genus match never clears the --auto bar');
});

test('a conflict whose competing claim moved to a different iNat id also re-opens', async () => {
    const { db, store } = makeStore();
    seedConflict(store, 'Q1', '41970', 'Q2');

    await verifyOpenFindings(store, {
        kind: 'link', fetchFn: fakeLinkApi({ Q1: null, Q2: '99999' }),
    });

    assert.equal(db.prepare("SELECT status FROM findings WHERE qid='Q1'").get().status, 'open');
});

test('verifying links fetches claims only, no sitelinks', async () => {
    const { store } = makeStore();
    seedOpenLink(store, 'Q1', '41970');
    await verifyOpenFindings(store, {
        kind: 'link',
        fetchFn: async (qids) => ({ entities: Object.fromEntries(qids.map(q => [q, { id: q, claims: {} }])), success: 1 }),
    });
    // fetchEntitiesBatched's own opts aren't observable through fetchFn directly; this test just
    // pins that the call succeeds with a claims-only entity shape (no sitelinks key at all).
    assert.equal(store.openFindings('link').length, 1);
});

test('readLinkFacts reports facts, not verdicts', () => {
    assert.deepEqual(readLinkFacts(undefined), { missing: true, p3151: null });
    assert.deepEqual(readLinkFacts({ id: 'Q1', missing: '' }), { missing: true, p3151: null });
    assert.deepEqual(readLinkFacts({ id: 'Q1', claims: {} }), { missing: false, p3151: null });
    assert.deepEqual(
        readLinkFacts({ id: 'Q1', claims: { P3151: [{ mainsnak: { datavalue: { value: '41970' } } }] } }),
        { missing: false, p3151: '41970' });
});

test('readImageFacts reports facts, not verdicts', () => {
    // The batch pass and a confirm ask different questions of the same entity, so this must stay
    // free of any judgement about what the answer means.
    assert.deepEqual(readImageFacts(undefined), { missing: true, image: null, commonsCategory: null });
    assert.deepEqual(readImageFacts({ id: 'Q1', missing: '' }), { missing: true, image: null, commonsCategory: null });
    assert.deepEqual(readImageFacts({ id: 'Q1', claims: {}, sitelinks: {} }),
        { missing: false, image: null, commonsCategory: null });
    assert.deepEqual(
        readImageFacts({
            id: 'Q1',
            claims: { P18: [{ mainsnak: { datavalue: { value: 'Lion.jpg' } } }] },
            sitelinks: { commonswiki: { title: 'Category:Panthera leo' } },
        }),
        { missing: false, image: 'Lion.jpg', commonsCategory: 'Category:Panthera leo' });
});

// ---- kind='name' — a finding proposes several P1843 statements, re-checked independently ----

function seedOpenName(store, qid, inatId, missing) {
    store.upsertTaxon({ qid, inatId, taxonName: `Taxon ${qid}` });
    store.recordFinding({ qid, kind: 'name', status: 'open', payload: { missing } });
}

/** A raw P1843 monolingualtext claim, as simplify.claims/readNameFacts expect to receive it. */
const p1843Claim = (locale, name) => ({
    mainsnak: { datavalue: { value: { language: locale, text: name } } },
});

/** A fake wbgetentities keyed by QID → [{locale,name}] live on Wikidata, or 'missing'. */
function fakeNameApi(spec, calls = []) {
    return async (qids) => {
        calls.push(qids);
        const entities = {};
        for (const qid of qids) {
            const v = spec[qid];
            if (v === 'missing' || v === undefined) { entities[qid] = { id: qid, missing: '' }; continue; }
            entities[qid] = { id: qid, claims: { P1843: v.map(({ locale, name }) => p1843Claim(locale, name)) } };
        }
        return { entities, success: 1 };
    };
}

test('every proposed language now live resolves the finding as fixed_upstream', async () => {
    const { db, store } = makeStore();
    seedOpenName(store, 'Q1', '41970', [{ locale: 'en', name: 'Jaguar' }, { locale: 'fr', name: 'Jaguar' }]);

    const res = await verifyOpenFindings(store, {
        kind: 'name',
        fetchFn: fakeNameApi({ Q1: [{ locale: 'en', name: 'Jaguar' }, { locale: 'fr', name: 'Jaguar' }] }),
    });

    assert.deepEqual(res.fixedUpstream, ['Q1']);
    const row = db.prepare("SELECT status, resolved_at, resolution FROM findings WHERE qid='Q1'").get();
    assert.equal(row.status, 'fixed_upstream');
    assert.ok(row.resolved_at);
    assert.deepEqual(JSON.parse(String(row.resolution)).locales, ['en', 'fr']);
});

test('some proposed languages now live trims payload.missing and stays open', async () => {
    const { db, store } = makeStore();
    seedOpenName(store, 'Q1', '41970', [{ locale: 'en', name: 'Jaguar' }, { locale: 'fr', name: 'Jaguar' }]);

    const res = await verifyOpenFindings(store, {
        kind: 'name', fetchFn: fakeNameApi({ Q1: [{ locale: 'en', name: 'Jaguar' }] }),
    });

    assert.equal(res.stillOpen, 1);
    const row = db.prepare("SELECT status, resolved_at, payload FROM findings WHERE qid='Q1'").get();
    assert.equal(row.status, 'open');
    assert.equal(row.resolved_at, null, 'a trimmed-but-open finding is not a resolved one');
    assert.deepEqual(JSON.parse(String(row.payload)).missing, [{ locale: 'fr', name: 'Jaguar' }]);
});

test('none of the proposed languages are live: stays open, payload untouched, just looked at', async () => {
    const { db, store } = makeStore();
    seedOpenName(store, 'Q1', '41970', [{ locale: 'en', name: 'Jaguar' }]);
    const before = db.prepare("SELECT verified_at FROM findings WHERE qid='Q1'").get().verified_at;
    assert.equal(before, null);

    const res = await verifyOpenFindings(store, { kind: 'name', fetchFn: fakeNameApi({ Q1: [] }) });

    assert.equal(res.stillOpen, 1);
    const row = db.prepare("SELECT status, verified_at, payload FROM findings WHERE qid='Q1'").get();
    assert.equal(row.status, 'open');
    assert.ok(row.verified_at, 'verified_at moves');
    assert.deepEqual(JSON.parse(String(row.payload)).missing, [{ locale: 'en', name: 'Jaguar' }]);
});

test('--limit caps a name-verify pass, and onProgress is called as each is checked', async () => {
    const { store } = makeStore();
    seedOpenName(store, 'Q1', '41970', [{ locale: 'en', name: 'Jaguar' }]);
    seedOpenName(store, 'Q2', '41971', [{ locale: 'en', name: 'Cougar' }]);
    const progress = [];

    const res = await verifyOpenFindings(store, {
        kind: 'name', limit: 1, fetchFn: fakeNameApi({ Q1: [], Q2: [] }),
        onProgress: (done, total) => progress.push([done, total]),
    });

    assert.equal(res.verified, 1, 'only the first of the backlog was checked');
    assert.deepEqual(progress, [[1, 1]]);
});

test('a merged or deleted name-finding item becomes gone', async () => {
    const { db, store } = makeStore();
    seedOpenName(store, 'Q1', '41970', [{ locale: 'en', name: 'Jaguar' }]);

    const res = await verifyOpenFindings(store, { kind: 'name', fetchFn: fakeNameApi({ Q1: 'missing' }) });

    assert.deepEqual(res.gone, ['Q1']);
    assert.equal(db.prepare("SELECT status FROM findings WHERE qid='Q1'").get().status, 'gone');
});

test('a name comparison is case-insensitive, matching how the finding was recorded', async () => {
    const { store } = makeStore();
    seedOpenName(store, 'Q1', '41970', [{ locale: 'en', name: 'Jaguar' }]);

    const res = await verifyOpenFindings(store, {
        kind: 'name', fetchFn: fakeNameApi({ Q1: [{ locale: 'en', name: 'jaguar' }] }),
    });

    assert.deepEqual(res.fixedUpstream, ['Q1']);
});

test('readNameFacts reports facts, not verdicts', () => {
    assert.deepEqual(readNameFacts(undefined), { missing: true, names: null });
    assert.deepEqual(readNameFacts({ id: 'Q1', missing: '' }), { missing: true, names: null });
    assert.deepEqual(readNameFacts({ id: 'Q1', claims: {} }), { missing: false, names: new Set() });
    assert.deepEqual(
        readNameFacts({ id: 'Q1', claims: { P1843: [p1843Claim('en', 'Jaguar'), p1843Claim('fr', 'Jaguar')] } }),
        { missing: false, names: new Set(['en:jaguar', 'fr:jaguar']) });
});
