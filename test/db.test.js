// @ts-check
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { createFindingsStore, migrate, DEFAULT_RECHECK_DAYS } from '../lib/db.js';

// A migrated in-memory findings DB, so the real schema and queries are exercised without a file.
function makeStore() {
    const db = new DatabaseSync(':memory:');
    migrate(db);
    return { db, store: createFindingsStore(db) };
}

/** Backdate a finding's checked_at by `days`, to test negative-result expiry without sleeping. */
function backdate(db, qid, days) {
    const when = new Date(Date.now() - days * 86_400_000).toISOString();
    db.prepare('UPDATE findings SET checked_at = ? WHERE qid = ?').run(when, qid);
}

function seed(store, qid, status, payload) {
    store.upsertTaxon({ qid, inatId: `inat-${qid}`, taxonName: `Taxon ${qid}`, iucn: 'VU' });
    store.recordFinding({ qid, kind: 'image', status, payload });
}

test('migrate creates schema v1 and is idempotent', () => {
    const db = new DatabaseSync(':memory:');
    assert.equal(migrate(db), 1);
    assert.equal(Number(db.prepare('PRAGMA user_version').get().user_version), 1);
    assert.equal(migrate(db), 1, 're-running must not throw or bump the version');

    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(r => r.name);
    for (const t of ['taxa', 'findings', 'runs']) assert.ok(tables.includes(t), `${t} table exists`);
});

test('STRICT tables reject a wrong-typed value', () => {
    const { db, store } = makeStore();
    store.upsertTaxon({ qid: 'Q1' });
    // n_scanned is INTEGER; STRICT must refuse a string that is not a number
    assert.throws(
        () => db.prepare('INSERT INTO runs (tool, started_at, n_scanned) VALUES (?, ?, ?)')
            .run('images', new Date().toISOString(), 'not-a-number'),
        /cannot store TEXT value in INTEGER column/i);
});

test('recordFinding upserts on (qid, kind) rather than duplicating', () => {
    const { db, store } = makeStore();
    seed(store, 'Q1', 'no_photos');
    seed(store, 'Q1', 'open', { wikitext: '{{Species|Panthera onca|}}' });

    const rows = db.prepare("SELECT status, discovered_at, checked_at FROM findings WHERE qid = 'Q1'").all();
    assert.equal(rows.length, 1, 'one row per (qid, kind)');
    assert.equal(rows[0].status, 'open', 'status flips in place');
    assert.equal(store.openFindings('image').length, 1);
});

test('skipQids treats negative statuses as skips, not just open', () => {
    const { store } = makeStore();
    seed(store, 'Q1', 'open');
    seed(store, 'Q2', 'no_photos');
    seed(store, 'Q3', 'no_draft');
    seed(store, 'Q4', 'skipped');
    seed(store, 'Q5', 'done');

    const skip = store.skipQids('image');
    // The re-discovery trap: skipping only `open` would resurface everything else on the next
    // top-up, including taxa deliberately passed over.
    assert.deepEqual(skip, new Set(['Q1', 'Q2', 'Q3', 'Q4', 'Q5']));
});

test('a negative finding expires once it is older than the recheck window', () => {
    const { db, store } = makeStore();
    seed(store, 'Q1', 'no_photos');
    backdate(db, 'Q1', DEFAULT_RECHECK_DAYS + 1);

    assert.ok(!store.skipQids('image').has('Q1'), 'stale negative is a candidate again');
    assert.ok(store.skipQids('image', DEFAULT_RECHECK_DAYS + 30).has('Q1'),
        'the same row stays skipped under a wider window');
});

test('a settled finding never expires, however old', () => {
    const { db, store } = makeStore();
    seed(store, 'Q1', 'done');
    seed(store, 'Q2', 'open');
    backdate(db, 'Q1', 3650);
    backdate(db, 'Q2', 3650);

    const skip = store.skipQids('image', 1);
    assert.ok(skip.has('Q1'), 'done is settled — an edit was made, it cannot un-happen');
    assert.ok(skip.has('Q2'), 'open is settled — it is already on the worklist');
});

test('a re-check flips no_photos to open and keeps the original discovered_at', () => {
    const { db, store } = makeStore();
    seed(store, 'Q1', 'no_photos');
    const first = db.prepare("SELECT discovered_at FROM findings WHERE qid = 'Q1'").get().discovered_at;
    backdate(db, 'Q1', DEFAULT_RECHECK_DAYS + 1);
    const stale = db.prepare("SELECT checked_at FROM findings WHERE qid = 'Q1'").get().checked_at;

    seed(store, 'Q1', 'open', { wikitext: '{{Species|Panthera leo|}}' });
    const row = db.prepare("SELECT status, discovered_at, checked_at FROM findings WHERE qid = 'Q1'").get();

    assert.equal(row.status, 'open');
    assert.equal(row.discovered_at, first, 'discovered_at records the first sighting, not the re-check');
    assert.ok(row.checked_at > stale, 'checked_at moves forward on re-check');
    assert.ok(store.skipQids('image', 1).has('Q1'), 'now settled, so no longer expiring');
});

test('openFindings returns only open rows, shaped for the report', () => {
    const { store } = makeStore();
    seed(store, 'Q1', 'open', { wikitext: '{{Species|Panthera onca|}}' });
    seed(store, 'Q2', 'no_photos');
    seed(store, 'Q3', 'done', { wikitext: 'x' });

    const rows = store.openFindings('image');
    assert.equal(rows.length, 1);
    assert.deepEqual(rows[0], {
        qid: 'Q1',
        wdUri: 'http://www.wikidata.org/entity/Q1',
        inatTaxonId: 'inat-Q1',
        taxonName: 'Taxon Q1',
        iucn: 'VU',
        wikitext: '{{Species|Panthera onca|}}',
    });
});

test('upsertTaxon does not blank existing fields with nulls', () => {
    const { store } = makeStore();
    store.upsertTaxon({ qid: 'Q1', inatId: '42', taxonName: 'Panthera onca', iucn: 'NT' });
    store.upsertTaxon({ qid: 'Q1', inatId: '42' }); // a later pass that knows less
    store.recordFinding({ qid: 'Q1', kind: 'image', status: 'open', payload: { wikitext: 'w' } });

    const row = store.openFindings('image')[0];
    assert.equal(row.taxonName, 'Panthera onca', 'a null must not overwrite a known name');
});

test('statusCounts and the runs log record what a run did', () => {
    const { store } = makeStore();
    seed(store, 'Q1', 'open');
    seed(store, 'Q2', 'no_photos');
    seed(store, 'Q3', 'no_photos');

    assert.deepEqual(store.statusCounts('image'), { open: 1, no_photos: 2 });

    const id = store.startRun('images', { iucn: 'CR', limit: 20 });
    store.finishRun(id, { scanned: 3, found: 1 });
    assert.equal(typeof id, 'number');
});
