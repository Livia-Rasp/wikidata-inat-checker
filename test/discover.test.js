// @ts-check
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { createFindingsStore, migrate } from '../lib/db.js';
import { createTaxaAccessor } from '../lib/getInatTaxaDb.js';
import { discover, resolveTaxonScope, resolveIucn, DiscoveryError } from '../lib/discover.js';

function makeStore() {
    const db = new DatabaseSync(':memory:');
    migrate(db);
    return { db, store: createFindingsStore(db) };
}

function makeTaxaDb(rows = [
    ['1', 'Animalia', 'kingdom', null],
    ['2', 'Felidae', 'family', '1'],
    ['41962', 'Panthera', 'genus', '1/2'],
    ['41970', 'Panthera onca', 'species', '1/2/41962'],
    ['42048', 'Panthera leo', 'species', '1/2/41962'],
    ['999', 'Ambigua', 'species', '1'],
    ['998', 'Ambigua', 'genus', '1'],
]) {
    const db = new DatabaseSync(':memory:');
    db.exec('CREATE TABLE taxa (taxon_id TEXT PRIMARY KEY, name TEXT NOT NULL, rank TEXT NOT NULL, ancestry TEXT);');
    const ins = db.prepare('INSERT INTO taxa VALUES (?, ?, ?, ?)');
    for (const [id, name, rank, ancestry] of rows) ins.run(id, name, rank, ancestry ?? null);
    return createTaxaAccessor(db);
}

/** A Wikidata candidate stream: one row per iNat id. */
function candidates(ids) {
    return ids.map(id => ({
        wdUri: `http://www.wikidata.org/entity/Q${id}`, qid: `Q${id}`, inatId: id, iucnQid: null,
    }));
}

/** A fake iNat page endpoint; `withPhotos` is the set of iNat ids that have qualifying photos. */
function fakePage(withPhotos) {
    return async (taxonIds) => ({
        total_results: 1,
        results: taxonIds.filter(id => withPhotos.has(String(id)))
            .map(id => ({ taxon: { ancestor_ids: [Number(id)] } })),
    });
}

const noWait = async () => {};

/** discover() with the network replaced: candidate source stubbed, iNat faked, drafts stubbed. */
async function run(store, taxaDb, opts = {}) {
    const { ids = ['41970', '42048'], withPhotos = new Set(), ...rest } = opts;
    // The candidate source is chosen inside discover() from the scope, so the seam used here is
    // the taxa index plus a stubbed fetch; for the unscoped path we hand it the ids directly.
    taxaDb.allInatIds = () => ids;
    return discover({
        store,
        taxaDb,
        inatOptions: { fetchPage: fakePage(withPhotos), rateLimit: noWait },
        candidateSource: candidates(ids),
        // Draft generation walks Wikidata's P171 chain; stubbing it is what keeps this suite off
        // the network. `withDrafts` decides which taxa come back with wikitext.
        generateDrafts: async (available) => Object.fromEntries(
            Object.keys(available)
                .filter(uri => (opts.withDrafts ?? withPhotos).has(uri.split('/').pop().slice(1)))
                .map(uri => [uri, `{{Species|Taxon ${uri.split('/').pop()}|}}`])),
        ...rest,
    });
}

// ---- scope resolution: the input that used to kill the process ----

test('an unknown taxon throws instead of exiting', () => {
    const taxaDb = makeTaxaDb();
    // checkImages.js called process.exit(1) here. Over HTTP that is an unauthenticated remote kill.
    assert.throws(() => resolveTaxonScope('Nonexistentia', taxaDb), (err) => {
        assert.ok(err instanceof DiscoveryError);
        assert.equal(err.code, 'unknown_taxon');
        return true;
    });
});

test('an ambiguous taxon throws and says which ids to choose between', () => {
    const taxaDb = makeTaxaDb();
    assert.throws(() => resolveTaxonScope('Ambigua', taxaDb), (err) => {
        assert.equal(err.code, 'ambiguous_taxon');
        assert.deepEqual(err.details.matches.map(m => m.inatId).sort(), ['998', '999']);
        return true;
    });
});

test('a numeric scope skips the name lookup, and takes the clade with it', () => {
    const taxaDb = makeTaxaDb();
    const { taxonId, ids } = resolveTaxonScope('41962', taxaDb);
    assert.equal(taxonId, '41962');
    assert.deepEqual(ids.sort(), ['41962', '41970', '42048']);
});

test('a wildcard scope cannot become a whole-table scan', () => {
    const taxaDb = makeTaxaDb();
    // '%' is a LIKE metacharacter, and descendantInatIds interpolates the id into LIKE patterns.
    // Unguarded it matches every row, turning one request into hundreds of SPARQL queries.
    assert.throws(() => resolveTaxonScope('%', taxaDb), /not in the iNat taxa index/);
});

test('IUCN codes resolve through the closed map, and nothing else does', () => {
    assert.deepEqual(resolveIucn('cr'), { code: 'CR', qid: 'Q219127' });
    assert.equal(resolveIucn(null), null);
    assert.throws(() => resolveIucn('ZZ'), (err) => err.code === 'unknown_iucn');
    // A plain object literal answers `constructor` with a function; own-property only.
    assert.throws(() => resolveIucn('constructor'), (err) => err.code === 'unknown_iucn');
});

test('a bad scope leaves no run behind', async () => {
    const { db, store } = makeStore();
    await assert.rejects(() => discover({ store, taxaDb: makeTaxaDb(), scope: { iucn: 'ZZ' } }),
        (err) => err.code === 'unknown_iucn');
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM runs').get().n, 0,
        'the scope is resolved before the run row is opened');
});

// ---- recording ----

test('every outcome is recorded, including the negatives', async () => {
    const { store } = makeStore();
    // Photos + a draft → open; photos but no draft → no_draft; no photos → no_photos. Recording
    // the negatives is the whole reason a re-run does not redo this work.
    await run(store, makeTaxaDb(), {
        ids: ['41970', '42048', '999'],
        withPhotos: new Set(['41970', '42048']),
        withDrafts: new Set(['41970']),
    });

    assert.deepEqual(store.statusCounts('image'), { open: 1, no_draft: 1, no_photos: 1 });
    assert.equal(store.openFindings('image')[0].qid, 'Q41970');
});

test('findings are written batch by batch, not all at the end', async () => {
    const { store } = makeStore();
    const seen = [];
    // 250 taxa is two iNat batches. After the first one is recorded the database must already
    // hold rows — that is what makes a killed or cancelled run keep the budget it spent.
    const ids = Array.from({ length: 250 }, (_, i) => String(i + 1));
    await run(store, makeTaxaDb(), {
        ids,
        onProgress: (p) => {
            if (p.phase === 'recording') seen.push({ batch: p.batch, rows: countRows(store) });
        },
    });
    assert.equal(seen.length, 2);
    assert.equal(seen[0].rows, 200, 'batch 1 is in the database before batch 2 is recorded');
    assert.equal(seen[1].rows, 250);
});

test('cancelling keeps the work already done', async () => {
    const { store } = makeStore();
    const controller = new AbortController();
    const ids = Array.from({ length: 250 }, (_, i) => String(i + 1));

    const result = await run(store, makeTaxaDb(), {
        ids,
        signal: controller.signal,
        onProgress: (p) => { if (p.phase === 'recording') controller.abort(); },
    });

    assert.equal(result.cancelled, true);
    assert.equal(countRows(store), 200, 'the completed batch survives a cancel');
});

test('the top-up trap: a taxon in any status is never re-offered', async () => {
    const { store } = makeStore();
    // Not just `open` — skipping only those would resurface everything deliberately passed over.
    for (const [qid, status] of [['Q1', 'open'], ['Q2', 'skipped'], ['Q3', 'done'],
        ['Q4', 'no_photos'], ['Q5', 'gone'], ['Q6', 'fixed_upstream']]) {
        store.upsertTaxon({ qid });
        store.recordFinding({ qid, kind: 'image', status });
    }

    const result = await run(store, makeTaxaDb(), { ids: ['1', '2', '3', '4', '5', '6'] });
    assert.equal(result.alreadyKnown, 6);
    assert.equal(result.scanned, 0, 'nothing new to check');
});

test('a run is recorded even when it throws partway', async () => {
    const { db, store } = makeStore();
    await assert.rejects(() => run(store, makeTaxaDb(), {
        inatOptions: { fetchPage: async () => { throw new Error('boom'); }, rateLimit: noWait },
        onProgress: (p) => { if (p.phase === 'checking' && p.taxa !== undefined) throw new Error('boom'); },
    }));
    const row = db.prepare('SELECT finished_at FROM runs').get();
    assert.ok(row.finished_at, 'finishRun happens in a finally, so history is never left dangling');
});

function countRows(store) {
    return Object.values(store.statusCounts('image')).reduce((a, b) => a + b, 0);
}

test('every progress event carries the run id', async () => {
    const { store } = makeStore();
    const seen = [];
    const result = await run(store, makeTaxaDb(), { onProgress: (p) => seen.push(p) });

    // Without this the server cannot offer a targeted cancel: it would only ever be able to stop
    // "whatever is running", which is a different thing from "the run I started".
    assert.ok(seen.length > 0);
    assert.ok(seen.every(p => p.runId === result.runId), 'including the very first one');
});

test('the run row says what became of the run', async () => {
    const { store } = makeStore();
    const controller = new AbortController();
    const ids = Array.from({ length: 250 }, (_, i) => String(i + 1));
    await run(store, makeTaxaDb(), {
        ids, signal: controller.signal,
        onProgress: (p) => { if (p.phase === 'recording') controller.abort(); },
    });
    // A cancelled run recorded as `done` would misreport a partial top-up as a complete one.
    assert.equal(store.latestRun('images').state, 'cancelled');

    await assert.rejects(() => run(store, makeTaxaDb(), {
        inatOptions: { fetchPage: async () => { throw new Error('/home/livia/secret/path'); }, rateLimit: noWait },
        onProgress: (p) => { if (p.phase === 'querying') throw new DiscoveryError('boom', 'x'); },
    }));
    const failed = store.latestRun('images');
    assert.equal(failed.state, 'failed');
    assert.equal(failed.error, 'boom', 'a code we chose, never a raw message with a path in it');
});
