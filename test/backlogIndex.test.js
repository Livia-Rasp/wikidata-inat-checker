// @ts-check
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { createTaxaAccessor } from '../lib/getInatTaxaDb.js';
import { createBacklogIndex } from '../lib/backlogIndex.js';

// The taxa index fixture, same shape as test/taxaDb.test.js: [taxon_id, name, rank, ancestry].
function makeTaxaDb(rows) {
    const db = new DatabaseSync(':memory:');
    db.exec('CREATE TABLE taxa (taxon_id TEXT PRIMARY KEY, name TEXT NOT NULL, rank TEXT NOT NULL, ancestry TEXT);');
    const ins = db.prepare('INSERT INTO taxa VALUES (?, ?, ?, ?)');
    for (const [id, name, rank, ancestry] of rows) ins.run(id, name, rank, ancestry ?? null);
    return createTaxaAccessor(db);
}

const TAXA = [
    ['48460', 'Life', 'stateofmatter', null],
    ['47126', 'Plantae', 'kingdom', '48460'],
    ['47217', 'Orchidaceae', 'family', '48460/47126'],
    ['128971', 'Bulbophyllum', 'genus', '48460/47126/47217'],
    ['9001', 'Bulbophyllum alpha', 'species', '48460/47126/47217/128971'],
    ['9002', 'Bulbophyllum beta', 'species', '48460/47126/47217/128971'],
    ['5555', 'Dendrobium', 'genus', '48460/47126/47217'],
    ['9003', 'Dendrobium gamma', 'species', '48460/47126/47217/5555'],
    ['7777', 'Quercus', 'genus', '48460/47126'],           // a plant, but not an orchid
    ['9004', 'Quercus robur', 'species', '48460/47126/7777'],
];

// A findings store stub with only the two methods the index calls.
function makeStore(findings, runAt = '2026-08-16T00:00:00Z') {
    let stamp = runAt;
    return {
        listFindings: () => findings.map(f => ({ ...f })),
        latestRunAt: () => stamp,
        setRunAt: (v) => { stamp = v; },
        push: (f) => findings.push(f),
    };
}

const FINDINGS = [
    { id: 1, qid: 'Q1', inatTaxonId: '9001', taxonName: 'Bulbophyllum alpha', iucn: 'CR' },
    { id: 2, qid: 'Q2', inatTaxonId: '9002', taxonName: 'Bulbophyllum beta', iucn: 'VU' },
    { id: 3, qid: 'Q3', inatTaxonId: '9003', taxonName: 'Dendrobium gamma', iucn: null },
    { id: 4, qid: 'Q4', inatTaxonId: '128971', taxonName: 'Bulbophyllum', iucn: null }, // direct member
    { id: 5, qid: 'Q5', inatTaxonId: '9004', taxonName: 'Quercus robur', iucn: 'CR' },  // outside
    { id: 6, qid: 'Q6', inatTaxonId: '404404', taxonName: 'Ghost taxon', iucn: null },  // not in the index
];

function make(overrides = {}) {
    return createBacklogIndex({
        store: makeStore(FINDINGS), taxaDb: makeTaxaDb(TAXA), ...overrides,
    });
}

test('a clade filter matches descendants at any depth, and the clade itself', () => {
    const got = make().search({ taxonId: '47217' });
    assert.deepEqual(got.rows.map(r => r.id), [1, 2, 3, 4]);
    assert.equal(got.total, 4);
});

test('a genus filter narrows to that genus, including the genus row itself', () => {
    const got = make().search({ taxonId: '128971' });
    assert.deepEqual(got.rows.map(r => r.id), [1, 2, 4]);
});

test('a taxon absent from the index simply never matches, and never throws', () => {
    // Backlog rows outlive the taxa index: iNat deactivates taxa, and the index only holds active
    // ones. A missing row must drop out of a clade search, not take the request down with it.
    const idx = make();
    assert.equal(idx.search({ taxonId: '47217' }).rows.some(r => r.id === 6), false);
    assert.equal(idx.search({ taxonId: '404404' }).total, 1, 'it still matches itself by id');
});

test('an unrelated clade shares an ancestor without sharing the backlog', () => {
    const idx = make();
    assert.deepEqual(idx.search({ taxonId: '7777' }).rows.map(r => r.id), [5]);
    assert.equal(idx.search({ taxonId: '47126' }).total, 5, 'the kingdom holds everything placed');
});

test('IUCN and clade compose', () => {
    const idx = make();
    assert.deepEqual(idx.search({ iucn: 'CR' }).rows.map(r => r.id), [1, 5]);
    assert.deepEqual(idx.search({ taxonId: '47217', iucn: 'CR' }).rows.map(r => r.id), [1]);
    assert.equal(idx.search({ taxonId: '47217', iucn: 'EX' }).total, 0);
});

test('IUCN counts describe the clade, not the filtered page', () => {
    const idx = make();
    assert.deepEqual(idx.search({}).iucnCounts, { CR: 2, VU: 1 });
    assert.deepEqual(idx.search({ taxonId: '47217' }).iucnCounts, { CR: 1, VU: 1 });
    // Still the whole clade while a status is selected — otherwise choosing CR would blank every
    // other chip and there would be no way to see what switching to VU would give.
    assert.deepEqual(idx.search({ taxonId: '47217', iucn: 'CR' }).iucnCounts, { CR: 1, VU: 1 });
});

test('composition counts the child clades one step down', () => {
    const got = make().search({ taxonId: '47217' });
    assert.equal(got.composition.under, null, 'one step down was enough, so there is nothing to say');
    assert.deepEqual(got.composition.entries, [
        { inatId: '128971', name: 'Bulbophyllum', rank: 'genus', count: 3 },
        { inatId: '5555', name: 'Dendrobium', rank: 'genus', count: 1 },
    ]);
});

test('composition descends past a single child to the first branch point', () => {
    // Everything placed in this backlog is a plant, so one step down from Life is a dead end.
    // Stopping there would offer nothing to navigate into; the useful answer is a rank further on.
    const idx = make();
    const got = idx.search({ taxonId: '48460' });
    assert.equal(got.total, 5, 'the unplaceable row is not under Life either');
    assert.deepEqual(got.composition.under,
        { inatId: '47126', name: 'Plantae', rank: 'kingdom' },
        'the strip must name the clade it descended to, or the counts are mysterious');
    assert.deepEqual(got.composition.entries.map(e => [e.name, e.count]),
        [['Orchidaceae', 4], ['Quercus', 1]]);
});

test('composition says nothing when there is nothing to break down', () => {
    const idx = make();
    // One child clade is the same number written twice, and an unscoped search has no clade to
    // break down at all.
    assert.deepEqual(idx.search({ taxonId: '5555' }).composition, { under: null, entries: [] });
    assert.deepEqual(idx.search({}).composition, { under: null, entries: [] });
    assert.deepEqual(idx.search({ taxonId: '47217', iucn: 'EX' }).composition,
        { under: null, entries: [] }, 'an empty result has no composition');
});

test('total counts every match, the page is what was asked for', () => {
    const idx = make();
    const got = idx.search({ taxonId: '47217', limit: 2, offset: 1 });
    assert.deepEqual(got.rows.map(r => r.id), [2, 3]);
    assert.equal(got.total, 4, 'total is the match count before paging, not the page size');
});

test('nameLike is the fallback when there is no index to resolve a clade with', () => {
    const idx = createBacklogIndex({ store: makeStore(FINDINGS), taxaDb: null });
    assert.deepEqual(idx.search({ nameLike: 'bulbophyllum' }).rows.map(r => r.id), [1, 2, 4]);
    assert.deepEqual(idx.search({ nameLike: 'QUERCUS' }).rows.map(r => r.id), [5]);
    assert.deepEqual(idx.search({ taxonId: '47217' }).rows, [], 'no index, no clade membership');
    assert.deepEqual(idx.search({ nameLike: 'ghost' }).composition, { under: null, entries: [] });
});

test('the row list is re-read when a run finishes, and not before', () => {
    const store = makeStore([...FINDINGS]);
    const idx = createBacklogIndex({ store, taxaDb: makeTaxaDb(TAXA) });
    assert.equal(idx.search({}).total, 6);

    store.push({ id: 7, qid: 'Q7', inatTaxonId: '9001', taxonName: 'Late arrival', iucn: null });
    assert.equal(idx.search({}).total, 6, 'a run in flight is not visible yet');

    store.setRunAt('2026-08-17T00:00:00Z');
    assert.equal(idx.search({}).total, 7, 'a finished run is');
});

test('the ancestor memo warms over the backlog, not over the queries', () => {
    const idx = make();
    idx.search({ taxonId: '47217' });
    const after = idx.stats().cached;
    idx.search({ taxonId: '128971' });
    idx.search({ taxonId: '7777' });
    assert.equal(idx.stats().cached, after,
        'a second clade must not cost another lookup per backlog row');
});
