// @ts-check
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { createFindingsStore, migrate } from '../lib/db.js';
import { pickCandidate } from '../lib/pick.js';

function makeStore() {
    const db = new DatabaseSync(':memory:');
    migrate(db);
    return { db, store: createFindingsStore(db) };
}

function seedAmbiguous(store, qid = 'Q1') {
    store.upsertTaxon({ qid, taxonName: 'Grania' });
    store.recordFinding({
        qid, kind: 'link', status: 'ambiguous',
        payload: {
            candidates: [
                { inatId: '111', rank: 'genus', evidence: { matches: 3, mismatches: 0, matchedRanks: ['family', 'genus', 'order'] }, score: null, scoredBy: null },
                { inatId: '222', rank: 'genus', evidence: { matches: 1, mismatches: 1, matchedRanks: ['genus'] }, score: null, scoredBy: null },
            ],
        },
    });
    return store.listFindings({ kind: 'link', status: 'ambiguous' })[0].id;
}

test('picking a listed candidate re-records the finding as open, evidence and autoEligible intact', () => {
    const { db, store } = makeStore();
    const id = seedAmbiguous(store);

    const result = pickCandidate(store, id, '111');

    assert.equal(result.picked, true);
    assert.equal(result.qid, 'Q1');
    const row = db.prepare("SELECT status, resolved_at, payload FROM findings WHERE qid='Q1'").get();
    assert.equal(row.status, 'open');
    assert.equal(row.resolved_at, null, 'picking is not a resolution');
    const payload = JSON.parse(String(row.payload));
    assert.equal(payload.inatId, '111');
    assert.equal(payload.rank, 'genus');
    assert.equal(payload.autoEligible, true, 'family+genus+order agreeing clears the --auto bar');
});

test('picking updates the taxa row\'s inat_id, which ambiguous discovery never had a chance to set', () => {
    const { db, store } = makeStore();
    const id = seedAmbiguous(store);
    pickCandidate(store, id, '111');
    const taxon = db.prepare("SELECT inat_id, rank FROM taxa WHERE qid = 'Q1'").get();
    assert.equal(taxon.inat_id, '111', 'the worklist row and its QuickStatements line read this column');
    assert.equal(taxon.rank, 'genus');
});

test('picking the weaker candidate is not auto-eligible', () => {
    const { store } = makeStore();
    const id = seedAmbiguous(store);
    const result = pickCandidate(store, id, '222');
    assert.equal(result.picked, true);
    const row = store.listFindings({ kind: 'link', status: 'open' })[0];
    assert.equal(store.getFinding(row.id).payload.autoEligible, false);
});

test('picking an inatId not among the candidates is refused, and changes nothing', () => {
    const { store } = makeStore();
    const id = seedAmbiguous(store);
    const result = pickCandidate(store, id, '999');
    assert.equal(result.picked, false);
    assert.equal(result.reason, 'unknown_candidate');
    assert.equal(store.getFinding(id).status, 'ambiguous', 'unchanged');
});

test('an unknown id says so instead of looking like a success', () => {
    const { store } = makeStore();
    const result = pickCandidate(store, 999_999, '111');
    assert.equal(result.picked, false);
    assert.equal(result.reason, 'not_found');
});

test('picking a candidate with no stored evidence falls back to a zeroed summary', () => {
    const { db, store } = makeStore();
    store.upsertTaxon({ qid: 'Q1', taxonName: 'Grania' });
    store.recordFinding({
        qid: 'Q1', kind: 'link', status: 'ambiguous',
        payload: { candidates: [{ inatId: '111', rank: 'genus' }] }, // no evidence field at all
    });
    const id = store.listFindings({ kind: 'link', status: 'ambiguous' })[0].id;

    const result = pickCandidate(store, id, '111');

    assert.equal(result.picked, true);
    const payload = JSON.parse(String(db.prepare("SELECT payload FROM findings WHERE qid='Q1'").get().payload));
    assert.deepEqual(payload.evidence, { matches: 0, mismatches: 0, matchedRanks: [] });
    assert.equal(payload.autoEligible, false);
});

test('an ambiguous finding recorded with no payload at all refuses every pick', () => {
    const { store } = makeStore();
    store.upsertTaxon({ qid: 'Q1', taxonName: 'Grania' });
    store.recordFinding({ qid: 'Q1', kind: 'link', status: 'ambiguous' }); // payload omitted → NULL
    const id = store.listFindings({ kind: 'link', status: 'ambiguous' })[0].id;

    const result = pickCandidate(store, id, '111');
    assert.equal(result.picked, false);
    assert.equal(result.reason, 'unknown_candidate');
});

test('picking on a non-ambiguous finding is refused', () => {
    const { store } = makeStore();
    store.upsertTaxon({ qid: 'Q2', inatId: '41970' });
    store.recordFinding({
        qid: 'Q2', kind: 'link', status: 'open',
        payload: { inatId: '41970', rank: 'species', evidence: { matches: 0, mismatches: 0, matchedRanks: [] }, autoEligible: false },
    });
    const id = store.listFindings({ kind: 'link', status: 'open' })[0].id;

    const result = pickCandidate(store, id, '41970');
    assert.equal(result.picked, false);
    assert.equal(result.reason, 'not_ambiguous');
});
