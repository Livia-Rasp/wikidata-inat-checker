// @ts-check
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { createFindingsStore, migrate } from '../lib/db.js';
import { confirmFindings, confirmLinkFindings, confirmByKind } from '../lib/confirm.js';

function makeStore() {
    const db = new DatabaseSync(':memory:');
    migrate(db);
    return { db, store: createFindingsStore(db) };
}

/** Seeds an open image finding and returns its id. */
function seedOpen(store, qid, wikitext = `{{Species|Taxon ${qid}|}}`) {
    store.upsertTaxon({ qid, inatId: `inat-${qid}`, taxonName: `Taxon ${qid}`, iucn: 'VU' });
    store.recordFinding({ qid, kind: 'image', status: 'open', payload: { wikitext } });
    return store.listFindings({ kind: 'image' }).find(f => f.qid === qid).id;
}

/**
 * A fake wbgetentities. `spec` maps QID → 'both' | 'imageOnly' | 'sitelinkOnly' | 'neither' |
 * 'missing', naming which half of this app's two-statement edit is live.
 */
function fakeApi(spec, calls = []) {
    return async (qids) => {
        calls.push(qids);
        const entities = {};
        for (const qid of qids) {
            const state = spec[qid] ?? 'neither';
            if (state === 'missing') { entities[qid] = { id: qid, missing: '' }; continue; }
            const hasImage = state === 'both' || state === 'imageOnly';
            const hasCat = state === 'both' || state === 'sitelinkOnly';
            entities[qid] = {
                id: qid,
                claims: hasImage
                    ? { P18: [{ mainsnak: { datavalue: { value: `${qid}.jpg`, type: 'string' } } }] }
                    : {},
                sitelinks: hasCat ? { commonswiki: { title: `Category:Taxon ${qid}` } } : {},
            };
        }
        return { entities, success: 1 };
    };
}

test('a finding is done only when both the image and the sitelink are live', async () => {
    const { db, store } = makeStore();
    const id = seedOpen(store, 'Q1');

    const [res] = await confirmFindings(store, [id], { fetchFn: fakeApi({ Q1: 'both' }) });

    assert.equal(res.confirmed, true);
    assert.equal(res.status, 'done');
    const row = db.prepare("SELECT status, resolved_at, resolution FROM findings WHERE qid='Q1'").get();
    assert.equal(row.status, 'done');
    assert.ok(row.resolved_at);
    const resolution = JSON.parse(row.resolution);
    assert.equal(resolution.file, 'Q1.jpg');
    assert.equal(resolution.sitelink, 'Category:Taxon Q1');
});

test('each way of being half-applied is reported distinguishably', async () => {
    // A QuickStatements batch can apply one statement and not the other, so "not confirmed" is
    // not a useful answer on its own — the point is knowing which half to go and fix.
    const cases = {
        imageOnly: 'missing_sitelink',
        sitelinkOnly: 'missing_p18',
        neither: 'missing_p18_and_sitelink',
    };
    for (const [state, reason] of Object.entries(cases)) {
        const { store } = makeStore();
        const id = seedOpen(store, 'Q1');
        const [res] = await confirmFindings(store, [id], { fetchFn: fakeApi({ Q1: state }) });

        assert.equal(res.confirmed, false, state);
        assert.equal(res.reason, reason, state);
        assert.equal(res.status, 'open', 'a failed confirm is a no-op, never an error state');
    }
});

test('a failed confirm records that we looked and destroys nothing', async () => {
    const { db, store } = makeStore();
    const id = seedOpen(store, 'Q1', '{{Species|Panthera onca|}}');

    await confirmFindings(store, [id], { fetchFn: fakeApi({ Q1: 'imageOnly' }) });

    const row = db.prepare("SELECT status, verified_at, resolved_at, payload FROM findings WHERE qid='Q1'").get();
    assert.equal(row.status, 'open');
    assert.ok(row.verified_at, 'verified_at moves — we did look');
    assert.equal(row.resolved_at, null, 'but nothing was resolved');
    // The trap markVerified exists to avoid: recordFinding would have nulled this.
    assert.equal(JSON.parse(row.payload).wikitext, '{{Species|Panthera onca|}}');
});

test('confirming records the picked file alongside the live one, and clears the pick', async () => {
    const { store } = makeStore();
    const id = seedOpen(store, 'Q1');
    store.recordUpload({ destFile: 'Q1.jpg', qid: 'Q1', photoId: '9', taxonName: 'Taxon Q1' });
    store.setP18Pick('Q1', 'Q1.jpg');

    const [res] = await confirmFindings(store, [id], { fetchFn: fakeApi({ Q1: 'both' }) });

    assert.equal(res.expectedFile, 'Q1.jpg');
    assert.deepEqual(store.p18Picks(), {}, 'a confirmed pick is spent');
    assert.equal(store.listUploads().length, 1, 'but the upload record itself survives');
});

test('a live image that is not the picked one still confirms, and the difference is recorded', async () => {
    const { db, store } = makeStore();
    const id = seedOpen(store, 'Q1');
    store.recordUpload({ destFile: 'Chosen.jpg', qid: 'Q1' });
    store.setP18Pick('Q1', 'Chosen.jpg');

    // Somebody (or an earlier batch) set a different image. The finding is still resolved — the
    // taxon has an image — but which file it turned out to be is worth being able to see.
    const [res] = await confirmFindings(store, [id], { fetchFn: fakeApi({ Q1: 'both' }) });

    assert.equal(res.confirmed, true);
    const resolution = JSON.parse(db.prepare("SELECT resolution FROM findings WHERE qid='Q1'").get().resolution);
    assert.equal(resolution.file, 'Q1.jpg');
    assert.equal(resolution.expectedFile, 'Chosen.jpg');
});

test('a deleted or merged item becomes gone', async () => {
    const { db, store } = makeStore();
    const id = seedOpen(store, 'Q1');

    const [res] = await confirmFindings(store, [id], { fetchFn: fakeApi({ Q1: 'missing' }) });

    assert.equal(res.reason, 'gone');
    assert.equal(db.prepare("SELECT status FROM findings WHERE qid='Q1'").get().status, 'gone');
});

test('an unknown id says so instead of looking like a success', async () => {
    const { store } = makeStore();
    const calls = [];
    // markVerified silently updates zero rows for an unknown key, so without getFinding this
    // would report a confirmed edit that never happened.
    const [res] = await confirmFindings(store, [999_999], { fetchFn: fakeApi({}, calls) });

    assert.equal(res.reason, 'not_found');
    assert.equal(res.confirmed, false);
    assert.equal(calls.length, 0, 'and it never bothered Wikidata');
});

test('confirming is idempotent and re-runnable', async () => {
    const { db, store } = makeStore();
    const id = seedOpen(store, 'Q1');
    const api = fakeApi({ Q1: 'both' });

    await confirmFindings(store, [id], { fetchFn: api });
    const first = db.prepare("SELECT resolved_at FROM findings WHERE qid='Q1'").get().resolved_at;
    const [again] = await confirmFindings(store, [id], { fetchFn: api });

    // A QuickStatements batch can be queued, so confirming twice must be safe and boring.
    assert.equal(again.confirmed, true);
    assert.equal(db.prepare("SELECT status FROM findings WHERE qid='Q1'").get().status, 'done');
    assert.ok(first);
});

test('a bulk confirm is one Wikidata round trip per 50 taxa, in the order asked', async () => {
    const { store } = makeStore();
    const ids = [];
    for (let i = 1; i <= 60; i++) ids.push(seedOpen(store, `Q${i}`));

    const calls = [];
    const results = await confirmFindings(store, ids, { fetchFn: fakeApi({}, calls) });

    assert.equal(calls.length, 2, '60 ids → 2 requests, not 60');
    assert.deepEqual(results.map(r => r.id), ids, 'one result per id, in order');
});

test('an upstream failure changes nothing at all', async () => {
    const { db, store } = makeStore();
    const id = seedOpen(store, 'Q1');

    await assert.rejects(
        () => confirmFindings(store, [id], { fetchFn: async () => { throw new Error('Wikidata API HTTP 503'); } }),
        /503/);

    const row = db.prepare("SELECT status, verified_at FROM findings WHERE qid='Q1'").get();
    assert.equal(row.status, 'open');
    assert.equal(row.verified_at, null, 'a confirm that never reached Wikidata decided nothing');
});

// ---- confirmLinkFindings: a single P3151 statement, no sitelink pairing, no pick bookkeeping ----

/** Seeds an open link finding and returns its id. */
function seedOpenLink(store, qid, inatId = `inat-${qid}`) {
    store.upsertTaxon({ qid, inatId, taxonName: `Taxon ${qid}` });
    store.recordFinding({
        qid, kind: 'link', status: 'open',
        payload: { inatId, rank: 'species', evidence: { matches: 3, mismatches: 0, matchedRanks: ['family', 'genus', 'order'] }, autoEligible: true },
    });
    return store.listFindings({ kind: 'link' }).find(f => f.qid === qid).id;
}

/** A fake wbgetentities keyed by QID → P3151 value (or 'missing'). */
function fakeLinkApi(spec, calls = []) {
    return async (qids) => {
        calls.push(qids);
        const entities = {};
        for (const qid of qids) {
            const v = spec[qid];
            if (v === 'missing' || v === undefined) { entities[qid] = { id: qid, missing: '' }; continue; }
            entities[qid] = { id: qid, claims: v === null ? {} : { P3151: [{ mainsnak: { datavalue: { value: v } } }] } };
        }
        return { entities, success: 1 };
    };
}

test('a link finding confirms once its own P3151 is live', async () => {
    const { db, store } = makeStore();
    const id = seedOpenLink(store, 'Q1', '41970');

    const [res] = await confirmLinkFindings(store, [id], { fetchFn: fakeLinkApi({ Q1: '41970' }) });

    assert.equal(res.confirmed, true);
    assert.equal(res.status, 'done');
    const row = db.prepare("SELECT status, resolution FROM findings WHERE qid='Q1'").get();
    assert.equal(JSON.parse(row.resolution).inatId, '41970');
});

test('a link finding with no live P3151 fails to confirm, distinguishably', async () => {
    const { store } = makeStore();
    const id = seedOpenLink(store, 'Q1', '41970');
    const [res] = await confirmLinkFindings(store, [id], { fetchFn: fakeLinkApi({ Q1: null }) });

    assert.equal(res.confirmed, false);
    assert.equal(res.reason, 'missing_p3151');
    assert.equal(res.status, 'open');
});

test('a deleted or merged link item becomes gone', async () => {
    const { db, store } = makeStore();
    const id = seedOpenLink(store, 'Q1');
    await confirmLinkFindings(store, [id], { fetchFn: fakeLinkApi({ Q1: 'missing' }) });
    assert.equal(db.prepare("SELECT status FROM findings WHERE qid='Q1'").get().status, 'gone');
});

test('confirmLinkFindings on an unknown id says so directly, not just through confirmByKind', async () => {
    const { store } = makeStore();
    const calls = [];
    const [res] = await confirmLinkFindings(store, [999_999], { fetchFn: fakeLinkApi({}, calls) });
    assert.equal(res.reason, 'not_found');
    assert.equal(res.confirmed, false);
    assert.equal(calls.length, 0, 'and it never bothered Wikidata');
});

// ---- confirmByKind: a bulk confirm can span kinds ----

test('confirmByKind dispatches each id to its own kind\'s predicate, in the order requested', async () => {
    const { store } = makeStore();
    const imgId = seedOpen(store, 'Q1');
    const linkId = seedOpenLink(store, 'Q2', '41970');

    const results = await confirmByKind(store, [linkId, imgId], {
        fetchFn: async (qids) => {
            const entities = {};
            for (const qid of qids) {
                entities[qid] = qid === 'Q1'
                    ? { id: qid, claims: { P18: [{ mainsnak: { datavalue: { value: 'Q1.jpg', type: 'string' } } }] }, sitelinks: { commonswiki: { title: 'Category:Taxon Q1' } } }
                    : { id: qid, claims: { P3151: [{ mainsnak: { datavalue: { value: '41970' } } }] } };
            }
            return { entities, success: 1 };
        },
    });

    assert.deepEqual(results.map(r => r.id), [linkId, imgId], 'results come back in the order requested');
    assert.ok(results.every(r => r.confirmed === true));
});

test('confirmByKind still reports an unknown id without touching the store', async () => {
    const { store } = makeStore();
    const [res] = await confirmByKind(store, [999_999], { fetchFn: fakeLinkApi({}) });
    assert.equal(res.reason, 'not_found');
});
