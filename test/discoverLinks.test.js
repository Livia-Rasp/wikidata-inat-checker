// @ts-check
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { discoverLinks } from '../lib/discoverLinks.js';
import { DiscoveryError } from '../lib/discover.js';
import { makeStore, makeTaxaDb as makeTaxaDbBase } from './helpers.js';

function makeTaxaDb(rows = [
    ['1', 'Animalia', 'kingdom', null],
    ['2', 'Felidae', 'family', '1'],
    ['3', 'Pantherinae', 'subfamily', '1/2'],
    ['41962', 'Panthera', 'genus', '1/2/3'],
    ['41970', 'Panthera onca', 'species', '1/2/3/41962'],
    ['998', 'Ambigua', 'genus', '1'],
    ['999', 'Ambigua', 'species', '1'],
]) {
    return makeTaxaDbBase(rows);
}

/** A WD candidate stream: one row per {qid, taxonName}. */
function candidates(rows) {
    return rows.map(({ qid, taxonName, iucnQid = null }) => ({
        wdUri: `http://www.wikidata.org/entity/${qid}`, qid, taxonName, iucnQid,
    }));
}

/**
 * A binding for one ancestor row of fetchWdAncestorChains' query, from a chain ordered
 * nearest-ancestor-first (directParent first). `rankQid` is a bare QID (e.g. 'Q34740'); URIs are
 * built here so the caller's fixtures stay readable.
 */
function chainBindings(itemQid, chain) {
    const uri = (qid) => `http://www.wikidata.org/entity/${qid}`;
    const out = [];
    for (let i = 0; i < chain.length; i++) {
        const a = chain[i];
        /** @type {any} */
        const row = {
            item: { value: uri(itemQid) },
            directParent: { value: uri(chain[0].qid) },
            ancestor: { value: uri(a.qid) },
            ancestorName: { value: a.name },
            ancestorRank: { value: uri(a.rankQid) },
        };
        if (chain[i + 1]) row.ancestorParent = { value: uri(chain[i + 1].qid) };
        out.push(row);
    }
    return out;
}

/**
 * A sparqlFn stub dispatching on which query shape it's handed: the P3151 cross-check, the
 * P13177 homonym check, or fetchWdAncestorChains' ancestor walk.
 * @param {{p3151?: Record<string, {wdUri: string, taxonName?: string}>, homonyms?: [string, string][], chains?: Record<string, {qid: string, name: string, rankQid: string}[]>}} cfg
 */
function makeSparqlStub({ p3151 = {}, homonyms = [], chains = {} } = {}) {
    return async (query) => {
        if (query.includes('wdt:P3151 ?inatId')) {
            return Object.entries(p3151).map(([inatId, v]) => ({
                item: { value: v.wdUri }, inatId: { value: inatId },
                ...(v.taxonName ? { taxonName: { value: v.taxonName } } : {}),
            }));
        }
        if (query.includes('wdt:P13177')) {
            return homonyms.map(([a, b]) => ({
                item1: { value: `http://www.wikidata.org/entity/${a}` },
                item2: { value: `http://www.wikidata.org/entity/${b}` },
            }));
        }
        if (query.includes('ancestorName')) {
            return Object.entries(chains).flatMap(([qid, chain]) => chainBindings(qid, chain));
        }
        throw new Error(`unexpected query: ${query.slice(0, 60)}`);
    };
}

const FELID_CHAIN = [
    { qid: 'Qgenus', name: 'Panthera', rankQid: 'Q34740' },
    { qid: 'Qsubfamily', name: 'Pantherinae', rankQid: 'Q164280' },
    { qid: 'Qfamily', name: 'Felidae', rankQid: 'Q35409' },
];

test('a name absent from the local index is recorded as no_match', async () => {
    const { store } = makeStore();
    const taxaDb = makeTaxaDb();
    const result = await discoverLinks({
        store, taxaDb, candidateSource: candidates([{ qid: 'Q1', taxonName: 'Nonexistentia' }]),
        sparqlFn: makeSparqlStub(),
    });
    assert.equal(result.noMatch, 1);
    assert.equal(result.open, 0);
    const rows = store.listFindings({ kind: 'link', status: 'no_match' });
    assert.equal(rows.length, 1);
    assert.equal(rows[0].qid, 'Q1');
});

test('an unclaimed single match becomes open, carrying evidence and auto-eligibility', async () => {
    const { db, store } = makeStore();
    const taxaDb = makeTaxaDb();
    const result = await discoverLinks({
        store, taxaDb,
        candidateSource: candidates([{ qid: 'Q1', taxonName: 'Panthera onca' }]),
        sparqlFn: makeSparqlStub({ chains: { Q1: FELID_CHAIN } }),
    });
    assert.equal(result.open, 1);
    const [row] = store.listFindings({ kind: 'link', status: 'open' });
    assert.equal(row.inatTaxonId, '41970');
    // listFindings' wikitext projection is image-shaped; read the link payload raw instead.
    const raw = db.prepare('SELECT payload FROM findings WHERE id = ?').get(row.id);
    const payload = JSON.parse(String(raw.payload));
    assert.equal(payload.inatId, '41970');
    assert.deepEqual(payload.evidence.matchedRanks.sort(), ['family', 'genus', 'subfamily']);
    assert.equal(payload.evidence.mismatches, 0);
    assert.equal(payload.autoEligible, true, 'family + genus + subfamily agreeing clears the --auto bar');
});

test('an already-claimed inatId under a different QID becomes a conflict, chains kept for the review UI', async () => {
    const { db, store } = makeStore();
    const taxaDb = makeTaxaDb();
    const result = await discoverLinks({
        store, taxaDb,
        candidateSource: candidates([{ qid: 'Q1', taxonName: 'Panthera onca' }]),
        sparqlFn: makeSparqlStub({
            p3151: { 41970: { wdUri: 'http://www.wikidata.org/entity/Q2', taxonName: 'Panthera onca' } },
            chains: { Q1: FELID_CHAIN },
        }),
    });
    assert.equal(result.conflict, 1);
    assert.equal(result.open, 0);
    const rows = store.listFindings({ kind: 'link', status: 'conflict' });
    assert.equal(rows.length, 1);
    assert.equal(rows[0].qid, 'Q1');
    const payload = JSON.parse(String(db.prepare('SELECT payload FROM findings WHERE id = ?').get(rows[0].id).payload));
    assert.equal(payload.wdChain.length, 3);
    assert.ok(Array.isArray(payload.inatChain));
});

test('a conflict already linked by P13177 is filtered out, not recorded', async () => {
    const { store } = makeStore();
    const taxaDb = makeTaxaDb();
    const result = await discoverLinks({
        store, taxaDb,
        candidateSource: candidates([{ qid: 'Q1', taxonName: 'Panthera onca' }]),
        sparqlFn: makeSparqlStub({
            p3151: { 41970: { wdUri: 'http://www.wikidata.org/entity/Q2' } },
            homonyms: [['Q1', 'Q2']],
        }),
    });
    assert.equal(result.conflict, 0);
    assert.equal(result.skipped, 1);
    assert.equal(store.listFindings({ kind: 'link', status: 'conflict' }).length, 0);
});

test('a name shared by 2+ local taxa becomes ambiguous, one candidate per local match, chains kept for the review UI', async () => {
    const { db, store } = makeStore();
    const taxaDb = makeTaxaDb();
    const result = await discoverLinks({
        store, taxaDb,
        candidateSource: candidates([{ qid: 'Q3', taxonName: 'Ambigua' }]),
        sparqlFn: makeSparqlStub({ chains: { Q3: FELID_CHAIN } }),
    });
    assert.equal(result.ambiguous, 1);
    const rows = store.listFindings({ kind: 'link', status: 'ambiguous' });
    assert.equal(rows.length, 1);
    const payload = JSON.parse(String(db.prepare('SELECT payload FROM findings WHERE id = ?').get(rows[0].id).payload));
    assert.equal(payload.wdChain.length, 3, 'the WD chain is kept in full, not just the evidence summary');
    assert.equal(payload.candidates.length, 2);
    for (const c of payload.candidates) assert.ok(Array.isArray(c.inatChain), `${c.inatId} carries its own iNat chain`);
});

test('a taxon scope keeps only candidates whose local match falls inside it', async () => {
    const { store } = makeStore();
    const taxaDb = makeTaxaDb();
    const result = await discoverLinks({
        store, taxaDb, scope: { taxon: '2' }, // Felidae
        candidateSource: candidates([
            { qid: 'Q1', taxonName: 'Panthera onca' }, // under Felidae
            { qid: 'Q4', taxonName: 'Nonexistentia' }, // no local match at all — always recorded
        ]),
        sparqlFn: makeSparqlStub({ chains: { Q1: FELID_CHAIN } }),
    });
    assert.equal(result.open, 1);
    assert.equal(result.noMatch, 1);
});

test('a bad IUCN scope leaves no run behind', async () => {
    const { db, store } = makeStore();
    const taxaDb = makeTaxaDb();
    await assert.rejects(
        () => discoverLinks({ store, taxaDb, scope: { iucn: 'ZZ' } }),
        (err) => err instanceof DiscoveryError && err.code === 'unknown_iucn');
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM runs').get().n, 0);
});

test('discovery skips a qid already settled as open, done or skipped', async () => {
    const { store } = makeStore();
    const taxaDb = makeTaxaDb();
    store.upsertTaxon({ qid: 'Q1', inatId: '41970', taxonName: 'Panthera onca' });
    store.recordFinding({ qid: 'Q1', kind: 'link', status: 'skipped' });
    const result = await discoverLinks({
        store, taxaDb,
        candidateSource: candidates([{ qid: 'Q1', taxonName: 'Panthera onca' }]),
        sparqlFn: makeSparqlStub(),
    });
    assert.equal(result.scanned, 0);
});

test('a mid-run failure is recorded on the run row and rethrown', async () => {
    const { db, store } = makeStore();
    const taxaDb = makeTaxaDb();
    const boom = new Error('SPARQL exploded');
    await assert.rejects(
        () => discoverLinks({
            store, taxaDb,
            candidateSource: candidates([{ qid: 'Q1', taxonName: 'Panthera onca' }]),
            sparqlFn: async () => { throw boom; },
        }),
        (err) => err === boom);

    const run = db.prepare('SELECT state, error FROM runs ORDER BY id DESC LIMIT 1').get();
    assert.equal(run.state, 'failed');
    assert.equal(run.error, 'run_failed');
});

test('--ambiguous-only records ambiguous and no_match findings but skips the cross-check', async () => {
    const { store } = makeStore();
    const taxaDb = makeTaxaDb();
    const result = await discoverLinks({
        store, taxaDb, ambiguousOnly: true,
        candidateSource: candidates([
            { qid: 'Q1', taxonName: 'Panthera onca' },
            { qid: 'Q3', taxonName: 'Ambigua' },
        ]),
        sparqlFn: makeSparqlStub({ chains: { Q3: [] } }), // no P3151/P13177 config: would throw if called
        signal: undefined,
    });
    assert.equal(result.open, 0, 'the single match is never cross-checked under ambiguous-only');
    assert.equal(result.ambiguous, 1);
});
