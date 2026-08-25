// @ts-check
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { createFindingsStore, migrate } from '../lib/db.js';
import { createTaxaAccessor, TaxaIndexUnavailable } from '../lib/getInatTaxaDb.js';
import { buildServer } from '../server/app.js';

const TAXA = [
    ['48460', 'Life', 'stateofmatter', null],
    ['47126', 'Plantae', 'kingdom', '48460'],
    ['47217', 'Orchidaceae', 'family', '48460/47126'],
    ['128971', 'Bulbophyllum', 'genus', '48460/47126/47217'],
    ['9001', 'Bulbophyllum alpha', 'species', '48460/47126/47217/128971'],
    ['5555', 'Dendrobium', 'genus', '48460/47126/47217'],
    ['9003', 'Dendrobium gamma', 'species', '48460/47126/47217/5555'],
    ['7777', 'Quercus', 'genus', '48460/47126'],
    ['9004', 'Quercus robur', 'species', '48460/47126/7777'],
    // A homonym, so the ambiguity path has something real to trip over.
    ['8001', 'Iris', 'genus', '48460/47126'],
    ['8002', 'Iris', 'genus', '48460/47126'],
];

function makeIndex() {
    const db = new DatabaseSync(':memory:');
    db.exec('CREATE TABLE taxa (taxon_id TEXT PRIMARY KEY, name TEXT NOT NULL, rank TEXT NOT NULL, ancestry TEXT);');
    const ins = db.prepare('INSERT INTO taxa VALUES (?, ?, ?, ?)');
    for (const [id, name, rank, ancestry] of TAXA) ins.run(id, name, rank, ancestry ?? null);
    return createTaxaAccessor(db);
}

const FINDINGS = [
    ['Q1', '9001', 'Bulbophyllum alpha', 'CR'],
    ['Q2', '9003', 'Dendrobium gamma', 'VU'],
    ['Q3', '9004', 'Quercus robur', 'CR'],
    ['Q4', '404404', 'Ghost taxon', null],
];

function makeApp(t, opts = {}) {
    const db = new DatabaseSync(':memory:');
    migrate(db);
    const store = createFindingsStore(db);
    for (const [qid, inatId, taxonName, iucn] of FINDINGS) {
        store.upsertTaxon({ qid, inatId, taxonName, iucn });
        store.recordFinding({ qid, kind: 'image', status: 'open', payload: { wikitext: `{{${taxonName}}}` } });
    }
    // A finished run, so the backlog index has a timestamp to key its row cache on.
    const runId = store.startRun('images', {});
    store.finishRun(runId, { scanned: 4, found: 4, state: 'done' });

    const app = buildServer({ store, openIndex: makeIndex, dbFile: ':memory:', ...opts });
    t.after(() => app.close());
    return { app, store };
}

const get = (app, url) => app.inject({ method: 'GET', url });

test('an unscoped search is the whole open backlog', async (t) => {
    const { app } = makeApp(t);
    const res = await get(app, '/api/search');
    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.equal(body.total, 4);
    assert.equal(body.count, 4);
    assert.equal(body.resolved, null);
    assert.equal(body.degraded, false);
    assert.deepEqual(body.composition, { under: null, entries: [] });
    // The row contract is the findings route's, not a second one.
    assert.deepEqual(Object.keys(body.taxa[0]).sort(),
        ['id', 'inatTaxonId', 'iucn', 'kind', 'payload', 'qid', 'status', 'taxonName', 'wdUri', 'wikitext']);
});

test('kind=link searches the link backlog independently from images', async (t) => {
    const { app, store } = makeApp(t);
    store.upsertTaxon({ qid: 'Q9', inatId: '9001', taxonName: 'Bulbophyllum alpha' });
    store.recordFinding({
        qid: 'Q9', kind: 'link', status: 'open',
        payload: { inatId: '9001', rank: 'species', evidence: { matches: 0, mismatches: 0, matchedRanks: [] }, autoEligible: false },
    });

    const images = (await get(app, '/api/search')).json();
    assert.equal(images.total, 4, 'the default kind is still images');

    const links = (await get(app, '/api/search?kind=link')).json();
    assert.equal(links.total, 1);
    assert.equal(links.taxa[0].qid, 'Q9');
});

test('kind=name searches the names backlog independently from images and links', async (t) => {
    const { app, store } = makeApp(t);
    store.upsertTaxon({ qid: 'Q9', inatId: '9001', taxonName: 'Bulbophyllum alpha' });
    store.recordFinding({
        qid: 'Q9', kind: 'name', status: 'open',
        payload: { missing: [{ locale: 'en', name: 'Alpha orchid' }] },
    });

    const names = (await get(app, '/api/search?kind=name')).json();
    assert.equal(names.total, 1);
    assert.equal(names.taxa[0].qid, 'Q9');
    assert.deepEqual(names.taxa[0].payload.missing, [{ locale: 'en', name: 'Alpha orchid' }]);
});

test('an unknown kind is rejected by the schema', async (t) => {
    const { app } = makeApp(t);
    assert.equal((await get(app, '/api/search?kind=nope')).statusCode, 400);
});

test('a clade search filters, resolves and describes', async (t) => {
    const { app } = makeApp(t);
    const body = (await get(app, '/api/search?taxon=Orchidaceae')).json();

    assert.equal(body.total, 2);
    assert.deepEqual(body.taxa.map(r => r.qid), ['Q1', 'Q2']);
    assert.equal(body.resolved.inatId, '47217');
    assert.equal(body.resolved.rank, 'family');
    assert.deepEqual(body.resolved.lineage.map(a => a.name), ['Plantae']);
    assert.deepEqual(body.composition.entries.map(e => [e.name, e.count]),
        [['Bulbophyllum', 1], ['Dendrobium', 1]]);
});

test('an iNat id searches the same clade as its name', async (t) => {
    const { app } = makeApp(t);
    const byName = (await get(app, '/api/search?taxon=Orchidaceae')).json();
    const byId = (await get(app, '/api/search?taxon=47217')).json();
    assert.deepEqual(byId.taxa.map(r => r.qid), byName.taxa.map(r => r.qid));
    assert.equal(byId.resolved.name, 'Orchidaceae');
});

test('clade and IUCN compose, and the counts survive serialisation', async (t) => {
    const { app } = makeApp(t);
    assert.equal((await get(app, '/api/search?iucn=CR')).json().total, 2);
    const both = (await get(app, '/api/search?taxon=Orchidaceae&iucn=CR')).json();
    assert.equal(both.total, 1);
    assert.equal(both.taxa[0].qid, 'Q1');
    // A response schema silently strips anything it does not list, so the counts are asserted
    // through HTTP and not only in the index's own test.
    assert.deepEqual(both.iucnCounts, { CR: 1, VU: 1 });
});

test('total counts the matches, not the page', async (t) => {
    const { app } = makeApp(t);
    const body = (await get(app, '/api/search?limit=1&offset=1')).json();
    assert.equal(body.total, 4, 'a truncated page must not pass itself off as the whole result');
    assert.equal(body.count, 1);
    assert.equal(body.taxa[0].qid, 'Q2');
});

test('paging walks the whole result exactly once', async (t) => {
    const { app } = makeApp(t);
    const seen = [];
    for (let offset = 0; ; offset += 2) {
        const body = (await get(app, `/api/search?limit=2&offset=${offset}`)).json();
        assert.equal(body.total, 4, 'total is the same on every page');
        assert.equal(body.offset, offset, 'the page says where it is, so a pager can be drawn');
        if (body.count === 0) break;
        seen.push(...body.taxa.map(r => r.qid));
    }
    assert.deepEqual(seen, ['Q1', 'Q2', 'Q3', 'Q4'], 'no row is skipped and none is repeated');
});

test('an offset past the end is empty, not an error', async (t) => {
    // A bookmarked page 4 of something that has since shrunk, or the last row of the last page
    // being skipped. The client falls back to the last page that exists; the server just answers.
    const { app } = makeApp(t);
    const body = (await get(app, '/api/search?limit=2&offset=500')).json();
    assert.equal(body.count, 0);
    assert.equal(body.total, 4, 'and still says how much there is to fall back to');
    assert.deepEqual(body.taxa, []);
});

test('an unknown or ambiguous taxon is a 400 the app can act on', async (t) => {
    const { app } = makeApp(t);

    const unknown = await get(app, '/api/search?taxon=Nonexistentia');
    assert.equal(unknown.statusCode, 400);
    assert.equal(unknown.json().code, 'unknown_taxon');

    // The same code and the same `matches` list discovery returns, so the app needs one prompt.
    const ambiguous = await get(app, '/api/search?taxon=Iris');
    assert.equal(ambiguous.statusCode, 400);
    assert.equal(ambiguous.json().code, 'ambiguous_taxon');
    assert.deepEqual(ambiguous.json().matches.map(m => m.inatId).sort(), ['8001', '8002']);
});

test('bad input is refused rather than silently defaulted', async (t) => {
    const { app } = makeApp(t);
    for (const url of [
        '/api/search?unknown=1',          // additionalProperties: false, or a typo returns the lot
        '/api/search?taxon=%25',          // a LIKE metacharacter must never reach the index
        '/api/search?taxon=',             // empty fails the pattern
        '/api/search?iucn=bogus',
        '/api/search?iucn=vu',            // the enum is upper-case, like discovery's
        '/api/search?limit=0',
        '/api/search?limit=99999',
        '/api/search?offset=-1',
        '/api/taxa/suggest',              // q is required
        '/api/taxa/suggest?q=',
        '/api/taxa/suggest?q=1234',       // a prefix starts with a letter
        '/api/taxa/suggest?q=Or&limit=50',
    ]) {
        assert.equal((await get(app, url)).statusCode, 400, `${url} must be refused`);
    }
});

test('suggest answers with clades first', async (t) => {
    const { app } = makeApp(t);
    const body = (await get(app, '/api/taxa/suggest?q=Orch')).json();
    assert.equal(body.degraded, false);
    assert.deepEqual(body.matches[0], { inatId: '47217', name: 'Orchidaceae', rank: 'family' });
    assert.deepEqual((await get(app, '/api/taxa/suggest?q=Zz')).json().matches, []);
});

test('without a taxa index, search degrades to names instead of failing', async (t) => {
    // Discovery 503s without the index because it cannot run at all. Search still can: the findings
    // database holds the names. The read surface is meant to go public, so it must not go down with
    // a file in ~/.cache.
    const { app } = makeApp(t, {
        openIndex: () => { throw new TaxaIndexUnavailable('missing', 'not built'); },
    });

    const body = (await get(app, '/api/search?taxon=Bulbophyllum')).json();
    assert.equal(body.degraded, true, 'the client must be told the clade was not resolved');
    assert.equal(body.resolved, null);
    assert.equal(body.total, 1);
    assert.equal(body.taxa[0].qid, 'Q1');
    assert.deepEqual(body.composition, { under: null, entries: [] });

    // An unresolvable name cannot be an error here — there is nothing to resolve it against.
    assert.equal((await get(app, '/api/search?taxon=Nonexistentia')).json().total, 0);

    const suggest = (await get(app, '/api/taxa/suggest?q=Orch')).json();
    assert.deepEqual(suggest, { degraded: true, matches: [] });
});

test('search is a read: no privilege, and nothing it can start', async (t) => {
    const { app } = makeApp(t);
    // A non-loopback peer with no browser headers is exactly what a future public deployment is.
    const res = await app.inject({
        method: 'GET', url: '/api/search?taxon=Orchidaceae', remoteAddress: '10.1.2.3',
    });
    assert.equal(res.statusCode, 200);
    assert.equal(res.headers['cache-control'], 'no-store', 'a cached backlog is stale work');
});
