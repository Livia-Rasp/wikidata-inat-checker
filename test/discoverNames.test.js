// @ts-check
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { createFindingsStore, migrate } from '../lib/db.js';
import { createTaxaAccessor } from '../lib/getInatTaxaDb.js';
import { discoverNames } from '../lib/discoverNames.js';
import { DiscoveryError } from '../lib/discover.js';

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
    ['998', 'Aves', 'class', '1'],
    ['999', 'Turdus merula', 'species', '1/998'],
]) {
    const db = new DatabaseSync(':memory:');
    db.exec('CREATE TABLE taxa (taxon_id TEXT PRIMARY KEY, name TEXT NOT NULL, rank TEXT NOT NULL, ancestry TEXT);');
    const ins = db.prepare('INSERT INTO taxa VALUES (?, ?, ?, ?)');
    for (const [id, name, rank, ancestry] of rows) ins.run(id, name, rank, ancestry ?? null);
    return createTaxaAccessor(db);
}

/** A WD candidate stream: one row per {qid, inatId}. */
function candidates(rows) {
    return rows.map(({ qid, inatId, iucnQid = null }) => ({
        wdUri: `http://www.wikidata.org/entity/${qid}`, qid, inatId, iucnQid,
    }));
}

/** A raw wbgetentities P225 claim, as simplify.claims expects to receive it. */
const p225 = (value) => [{
    mainsnak: { snaktype: 'value', property: 'P225', datavalue: { value, type: 'string' } },
    type: 'statement', rank: 'normal',
}];

/** Raw wbgetentities P1843 claims (monolingualtext), one per {locale, name} pair. */
const p1843 = (pairs) => pairs.map(({ locale, name }) => ({
    mainsnak: {
        snaktype: 'value', property: 'P1843',
        datavalue: { value: { text: name, language: locale }, type: 'monolingualtext' },
    },
    type: 'statement', rank: 'normal',
}));

/** A fetchEntitiesFn stub keyed by qid → {taxonName, names: [{locale,name}]} | 'missing'. */
function makeEntitiesStub(fixtures) {
    return async (qids) => Object.fromEntries(qids.map((qid) => {
        const f = fixtures[qid];
        // The real API marks a merged/deleted entity with `missing: ''` (confirmed live against
        // wbgetentities) — falsy, so discoverNames.js must test `!== undefined`, not truthiness.
        if (!f || f === 'missing') return [qid, { missing: '' }];
        return [qid, { claims: { P225: p225(f.taxonName), ...(f.names ? { P1843: p1843(f.names) } : {}) } }];
    }));
}

/** A fetchInatNamesFn stub keyed by inatId → [{locale,name}]. */
function makeInatNamesStub(fixtures) {
    return async (inatIds) => new Map(inatIds.map((id) => [id, fixtures[id] ?? []]));
}

test('a taxon with zero P1843 gets every iNat vernacular name recorded as missing', async () => {
    const { store } = makeStore();
    const taxaDb = makeTaxaDb();
    const result = await discoverNames({
        store, taxaDb,
        candidateSource: candidates([{ qid: 'Q1', inatId: '41970' }]),
        fetchEntitiesFn: makeEntitiesStub({ Q1: { taxonName: 'Panthera onca' } }),
        fetchInatNamesFn: makeInatNamesStub({
            41970: [{ locale: 'en', name: 'Jaguar' }, { locale: 'fr', name: 'Jaguar' }],
        }),
    });
    assert.equal(result.open, 1);
    const [row] = store.listFindings({ kind: 'name', status: 'open' });
    assert.equal(row.qid, 'Q1');
    assert.deepEqual(row.payload.missing, [
        { locale: 'en', name: 'Jaguar' }, { locale: 'fr', name: 'Jaguar' },
    ]);
});

test('a taxon with some P1843 already is skipped entirely in default mode', async () => {
    const { store } = makeStore();
    const taxaDb = makeTaxaDb();
    const result = await discoverNames({
        store, taxaDb,
        candidateSource: candidates([{ qid: 'Q1', inatId: '41970' }]),
        fetchEntitiesFn: makeEntitiesStub({
            Q1: { taxonName: 'Panthera onca', names: [{ locale: 'de', name: 'Jaguar' }] },
        }),
        fetchInatNamesFn: makeInatNamesStub({
            41970: [{ locale: 'en', name: 'Jaguar' }, { locale: 'de', name: 'Jaguar' }],
        }),
    });
    assert.equal(result.open, 0);
    assert.equal(store.listFindings({ kind: 'name', status: 'open' }).length, 0);
});

test('--all records only the still-absent languages for a taxon that already has some P1843', async () => {
    const { store } = makeStore();
    const taxaDb = makeTaxaDb();
    const result = await discoverNames({
        store, taxaDb, showAll: true,
        candidateSource: candidates([{ qid: 'Q1', inatId: '41970' }]),
        fetchEntitiesFn: makeEntitiesStub({
            Q1: { taxonName: 'Panthera onca', names: [{ locale: 'de', name: 'Jaguar' }] },
        }),
        fetchInatNamesFn: makeInatNamesStub({
            41970: [{ locale: 'en', name: 'Jaguar' }, { locale: 'de', name: 'Jaguar' }],
        }),
    });
    assert.equal(result.open, 1);
    const [row] = store.listFindings({ kind: 'name', status: 'open' });
    assert.deepEqual(row.payload.missing, [{ locale: 'en', name: 'Jaguar' }]);
});

test('a name equal to the scientific name or its bare genus is excluded (genus-as-vernacular leak)', async () => {
    const { store } = makeStore();
    const taxaDb = makeTaxaDb();
    const result = await discoverNames({
        store, taxaDb,
        candidateSource: candidates([{ qid: 'Q1', inatId: '41970' }]),
        fetchEntitiesFn: makeEntitiesStub({ Q1: { taxonName: 'Panthera onca' } }),
        fetchInatNamesFn: makeInatNamesStub({
            41970: [
                { locale: 'de', name: 'Panthera' }, // bare genus leak
                { locale: 'la', name: 'Panthera onca' }, // exact scientific name
                { locale: 'en', name: 'Jaguar' }, // genuinely a vernacular name
            ],
        }),
    });
    assert.equal(result.open, 1);
    const [row] = store.listFindings({ kind: 'name', status: 'open' });
    assert.deepEqual(row.payload.missing, [{ locale: 'en', name: 'Jaguar' }]);
});

test('a duplicate qid in the candidate stream is deduped', async () => {
    const { store } = makeStore();
    const taxaDb = makeTaxaDb();
    const result = await discoverNames({
        store, taxaDb,
        candidateSource: candidates([
            { qid: 'Q1', inatId: '41970' }, { qid: 'Q1', inatId: '41970' },
        ]),
        fetchEntitiesFn: makeEntitiesStub({ Q1: { taxonName: 'Panthera onca' } }),
        fetchInatNamesFn: makeInatNamesStub({ 41970: [{ locale: 'en', name: 'Jaguar' }] }),
    });
    assert.equal(result.scanned, 1);
    assert.equal(result.open, 1);
});

test('a candidate merged or deleted between collection and the entity fetch is skipped, not recorded', async () => {
    const { store } = makeStore();
    const taxaDb = makeTaxaDb();
    const result = await discoverNames({
        store, taxaDb,
        candidateSource: candidates([{ qid: 'Q1', inatId: '41970' }, { qid: 'Q2', inatId: '999' }]),
        fetchEntitiesFn: makeEntitiesStub({ Q1: 'missing', Q2: { taxonName: 'Turdus merula' } }),
        fetchInatNamesFn: makeInatNamesStub({ 999: [{ locale: 'en', name: 'Blackbird' }] }),
    });
    assert.equal(result.scanned, 2);
    assert.equal(result.open, 1);
    assert.equal(store.listFindings({ kind: 'name', status: 'open' })[0].qid, 'Q2');
});

test('--limit stops collecting candidates once reached', async () => {
    const { store } = makeStore();
    const taxaDb = makeTaxaDb();
    const result = await discoverNames({
        store, taxaDb, limit: 1,
        candidateSource: candidates([{ qid: 'Q1', inatId: '41970' }, { qid: 'Q2', inatId: '999' }]),
        fetchEntitiesFn: makeEntitiesStub({
            Q1: { taxonName: 'Panthera onca' }, Q2: { taxonName: 'Turdus merula' },
        }),
        fetchInatNamesFn: makeInatNamesStub({
            41970: [{ locale: 'en', name: 'Jaguar' }], 999: [{ locale: 'en', name: 'Blackbird' }],
        }),
    });
    assert.equal(result.scanned, 1, 'collection stopped at the limit, before the second candidate');
});

test('a candidate\'s IUCN status rides along onto the taxon row', async () => {
    const { store } = makeStore();
    const taxaDb = makeTaxaDb();
    await discoverNames({
        store, taxaDb,
        candidateSource: candidates([{ qid: 'Q1', inatId: '41970', iucnQid: 'Q278113' }]), // VU
        fetchEntitiesFn: makeEntitiesStub({ Q1: { taxonName: 'Panthera onca' } }),
        fetchInatNamesFn: makeInatNamesStub({ 41970: [{ locale: 'en', name: 'Jaguar' }] }),
    });
    const [row] = store.listFindings({ kind: 'name', status: 'open' });
    assert.equal(row.iucn, 'VU');
});

test('a candidate iNat never returned names for has nothing missing, and is not recorded', async () => {
    const { store } = makeStore();
    const taxaDb = makeTaxaDb();
    const result = await discoverNames({
        store, taxaDb,
        candidateSource: candidates([{ qid: 'Q1', inatId: '41970' }]),
        fetchEntitiesFn: makeEntitiesStub({ Q1: { taxonName: 'Panthera onca' } }),
        fetchInatNamesFn: async () => new Map(), // iNat had nothing at all for this taxon
    });
    assert.equal(result.open, 0);
    assert.equal(store.listFindings({ kind: 'name', status: 'open' }).length, 0);
});

test('a qid already settled is skipped, and a bad IUCN scope leaves no run behind', async () => {
    const { store, db } = makeStore();
    const taxaDb = makeTaxaDb();
    store.upsertTaxon({ qid: 'Q1', inatId: '41970', taxonName: 'Panthera onca' });
    store.recordFinding({ qid: 'Q1', kind: 'name', status: 'skipped' });

    const result = await discoverNames({
        store, taxaDb,
        candidateSource: candidates([{ qid: 'Q1', inatId: '41970' }]),
        fetchEntitiesFn: makeEntitiesStub({}),
        fetchInatNamesFn: makeInatNamesStub({}),
    });
    assert.equal(result.scanned, 0);

    await assert.rejects(
        () => discoverNames({ store, taxaDb, scope: { iucn: 'ZZ' } }),
        (err) => err instanceof DiscoveryError && err.code === 'unknown_iucn');
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM runs').get().n, 1, 'only the first, valid run was recorded');
});

test('a taxon scope keeps only candidates whose inatId falls inside it', async () => {
    const { store } = makeStore();
    const taxaDb = makeTaxaDb();
    const result = await discoverNames({
        store, taxaDb, scope: { taxon: '2' }, // Felidae
        candidateSource: candidates([
            { qid: 'Q1', inatId: '41970' }, // Panthera onca, under Felidae
            { qid: 'Q2', inatId: '999' },   // Turdus merula, outside Felidae
        ]),
        fetchEntitiesFn: makeEntitiesStub({
            Q1: { taxonName: 'Panthera onca' }, Q2: { taxonName: 'Turdus merula' },
        }),
        fetchInatNamesFn: makeInatNamesStub({
            41970: [{ locale: 'en', name: 'Jaguar' }], 999: [{ locale: 'en', name: 'Blackbird' }],
        }),
    });
    assert.equal(result.scanned, 1);
    assert.equal(store.listFindings({ kind: 'name', status: 'open' })[0].qid, 'Q1');
});

test('a mid-run failure is recorded on the run row and rethrown', async () => {
    const { db, store } = makeStore();
    const taxaDb = makeTaxaDb();
    const boom = new Error('Wikidata exploded');
    await assert.rejects(
        () => discoverNames({
            store, taxaDb,
            candidateSource: candidates([{ qid: 'Q1', inatId: '41970' }]),
            fetchEntitiesFn: async () => { throw boom; },
            fetchInatNamesFn: makeInatNamesStub({}),
        }),
        (err) => err === boom);

    const run = db.prepare('SELECT state, error FROM runs ORDER BY id DESC LIMIT 1').get();
    assert.equal(run.state, 'failed');
    assert.equal(run.error, 'run_failed');
});
