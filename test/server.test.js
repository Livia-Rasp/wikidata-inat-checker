// @ts-check
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { createFindingsStore, migrate } from '../lib/db.js';
import { buildServer } from '../server/app.js';

// Same in-memory fixture as test/db.test.js, so the real schema and queries are exercised without
// a file — and buildServer takes the store, never a path, which is what makes that possible.
function makeStore() {
    const db = new DatabaseSync(':memory:');
    migrate(db);
    return createFindingsStore(db);
}

function seed(store, qid, { kind = 'image', status = 'open', wikitext = `draft ${qid}` } = {}) {
    store.upsertTaxon({ qid, inatId: `inat-${qid}`, taxonName: `Taxon ${qid}`, iucn: 'VU' });
    store.recordFinding({ qid, kind, status, payload: wikitext ? { wikitext } : undefined });
}

/** A fresh app per test: rate-limit counters live on the instance. */
function makeApp(t, { store = makeStore(), ...opts } = {}) {
    const app = buildServer({ store, ...opts });
    t.after(() => app.close());
    return { app, store };
}

// ---- the findings API ----

test('GET /api/findings defaults to the open image backlog', async (t) => {
    const { app, store } = makeApp(t);
    seed(store, 'Q1');
    seed(store, 'Q2', { status: 'done' });
    seed(store, 'Q3', { status: 'no_photos', wikitext: null });
    seed(store, 'Q4', { kind: 'name' });

    const res = await app.inject('/api/findings');
    assert.equal(res.statusCode, 200);
    assert.match(res.headers['content-type'], /application\/json/);
    const body = res.json();
    assert.deepEqual(body.taxa.map(r => r.qid), ['Q1']);
    assert.equal(body.total, 1);
    assert.equal(body.count, 1);
});

test('a finding row carries exactly the documented fields', async (t) => {
    const { app, store } = makeApp(t);
    seed(store, 'Q1');

    const row = (await app.inject('/api/findings')).json().taxa[0];
    // The response schema strips anything not listed in it, so this is what stops a future
    // migration — or a typo in the schema — silently dropping a column the app renders.
    assert.deepEqual(Object.keys(row).sort(),
        ['id', 'inatTaxonId', 'iucn', 'kind', 'payload', 'qid', 'status', 'taxonName', 'wdUri', 'wikitext']);
    assert.equal(row.qid, 'Q1');
    assert.equal(row.kind, 'image');
    assert.equal(row.status, 'open');
    assert.equal(row.iucn, 'VU');
    assert.equal(row.wdUri, 'http://www.wikidata.org/entity/Q1');
    assert.equal(typeof row.id, 'number');
});

test('nullable columns survive serialisation as null, not as empty strings', async (t) => {
    const { app, store } = makeApp(t);
    store.upsertTaxon({ qid: 'Q1' }); // nothing known but the qid
    store.recordFinding({ qid: 'Q1', kind: 'image', status: 'open' });

    const row = (await app.inject('/api/findings')).json().taxa[0];
    assert.equal(row.inatTaxonId, null);
    assert.equal(row.taxonName, null);
    assert.equal(row.iucn, null);
    assert.equal(row.wikitext, null);
});

test('a link finding\'s payload (evidence, autoEligible) reaches the client', async (t) => {
    const { app, store } = makeApp(t);
    store.upsertTaxon({ qid: 'Q1', inatId: '41970', taxonName: 'Taxon Q1' });
    store.recordFinding({
        qid: 'Q1', kind: 'link', status: 'open',
        payload: { inatId: '41970', rank: 'species', evidence: { matches: 3, mismatches: 0, matchedRanks: ['family', 'genus', 'order'] }, autoEligible: true },
    });

    const row = (await app.inject('/api/findings?kind=link')).json().taxa[0];
    assert.equal(row.payload.autoEligible, true);
    assert.deepEqual(row.payload.evidence.matchedRanks, ['family', 'genus', 'order']);
});

test('kind and status select a different worklist', async (t) => {
    const { app, store } = makeApp(t);
    seed(store, 'Q1');
    seed(store, 'Q2', { status: 'done' });
    seed(store, 'Q3', { kind: 'link' });

    assert.deepEqual((await app.inject('/api/findings?status=done')).json().taxa.map(r => r.qid), ['Q2']);
    assert.deepEqual((await app.inject('/api/findings?kind=link')).json().taxa.map(r => r.qid), ['Q3']);
});

test('limit and offset page stably, and total stays the untruncated count', async (t) => {
    const { app, store } = makeApp(t);
    for (const qid of ['Q10', 'Q9', 'Q2']) seed(store, qid);

    const all = (await app.inject('/api/findings')).json().taxa.map(r => r.qid);
    const first = (await app.inject('/api/findings?limit=2')).json();
    const second = (await app.inject('/api/findings?limit=2&offset=2')).json();

    assert.deepEqual(first.taxa.map(r => r.qid), all.slice(0, 2));
    assert.deepEqual(second.taxa.map(r => r.qid), all.slice(2));
    // A page that reports itself as the whole backlog is the failure mode worth guarding.
    assert.deepEqual([first.count, first.total], [2, 3]);
    assert.deepEqual([second.count, second.total], [1, 3]);
});

test('an empty database answers with the shape the app expects, not an error', async (t) => {
    const { app } = makeApp(t);
    const body = (await app.inject('/api/findings')).json();
    assert.deepEqual(body.taxa, []);
    assert.equal(body.total, 0);
    assert.equal(body.generated, null);
});

test('generated reports the last finished run and ignores an unfinished one', async (t) => {
    const { app, store } = makeApp(t);
    const id = store.startRun('images', {});
    store.finishRun(id, { scanned: 1, found: 0 });
    const finished = (await app.inject('/api/findings')).json().generated;
    assert.ok(finished);

    store.startRun('images', {}); // crashed, or still running
    assert.equal((await app.inject('/api/findings')).json().generated, finished,
        'an unfinished run must not present itself as fresh data');
});

test('the API is never cacheable', async (t) => {
    const { app } = makeApp(t);
    const res = await app.inject('/api/findings');
    assert.equal(res.headers['cache-control'], 'no-store');
});

// ---- rejected input ----

for (const query of [
    'kind=bogus', 'status=bogus', 'status=open&kind=', 'limit=0', 'limit=999999',
    'limit=abc', 'offset=-1', 'unknown=1', 'kind=image&kind=name',
]) {
    test(`GET /api/findings?${query} is rejected`, async (t) => {
        const { app } = makeApp(t);
        const res = await app.inject(`/api/findings?${query}`);
        assert.equal(res.statusCode, 400, `?${query} must not be answered as a query`);
    });
}

test('an internal failure never leaks the database path', async (t) => {
    const store = makeStore();
    store.listFindings = () => {
        throw new Error('SQLITE_CANTOPEN: unable to open /home/livia/repos/secret/data/findings.db');
    };
    const { app } = makeApp(t, { store });

    const res = await app.inject('/api/findings');
    assert.equal(res.statusCode, 500);
    assert.ok(!res.body.includes('/home/livia'), 'the filesystem must not be described to callers');
    assert.ok(!res.body.includes('SQLITE_CANTOPEN'));
});

test('POST to the findings resource is refused, not crashed', async (t) => {
    const { app } = makeApp(t);
    const res = await app.inject({ method: 'POST', url: '/api/findings', payload: {} });
    assert.equal(res.statusCode, 404);
    assert.match(res.headers['content-type'], /application\/json/);
});

test('an unknown /api path answers as JSON', async (t) => {
    const { app } = makeApp(t);
    const res = await app.inject('/api/nope');
    assert.equal(res.statusCode, 404);
    assert.match(res.headers['content-type'], /application\/json/);
});

// ---- write endpoints ----

/** A wbgetentities fake; `state` is 'both' | 'imageOnly' | 'neither' | 'missing'. */
function fakeApi(state = 'both') {
    return async (qids) => ({
        entities: Object.fromEntries(qids.map(qid => [qid,
            state === 'missing' ? { id: qid, missing: '' } : {
                id: qid,
                claims: state === 'both' || state === 'imageOnly'
                    ? { P18: [{ mainsnak: { datavalue: { value: `${qid}.jpg` } } }] } : {},
                sitelinks: state === 'both' ? { commonswiki: { title: `Category:${qid}` } } : {},
            }])),
        success: 1,
    });
}

/** Writes come from the app, so they carry what a browser would send. */
const post = (app, url, payload) => app.inject({
    method: 'POST',
    url,
    headers: { host: 'localhost:8080', 'sec-fetch-site': 'same-origin' },
    payload: payload ?? {},
});

const firstId = (store) => store.listFindings({ kind: 'image' })[0].id;

test('confirming a complete edit takes the finding off the backlog', async (t) => {
    const { app, store } = makeApp(t, { fetchFn: fakeApi('both') });
    seed(store, 'Q1');

    const res = await post(app, `/api/findings/${firstId(store)}/confirm`);
    assert.equal(res.statusCode, 200);
    assert.equal(res.json().results[0].confirmed, true);
    assert.deepEqual((await app.inject('/api/findings')).json().taxa, []);
});

test('confirming a half-applied batch leaves the row open and says which half is missing', async (t) => {
    const { app, store } = makeApp(t, { fetchFn: fakeApi('imageOnly') });
    seed(store, 'Q1');

    const [result] = (await post(app, `/api/findings/${firstId(store)}/confirm`)).json().results;
    assert.equal(result.confirmed, false);
    assert.equal(result.reason, 'missing_sitelink');
    assert.equal((await app.inject('/api/findings')).json().total, 1, 'still work to do');
});

test('a bulk confirm answers per id', async (t) => {
    const { app, store } = makeApp(t, { fetchFn: fakeApi('both') });
    seed(store, 'Q1');
    seed(store, 'Q2');
    const ids = store.listFindings({ kind: 'image' }).map(f => f.id);

    const res = await post(app, '/api/findings/confirm', { ids });
    assert.deepEqual(res.json().results.map(r => r.id), ids);
    assert.ok(res.json().results.every(r => r.confirmed));
});

test('when Wikidata cannot be reached the answer is 503 and nothing changes', async (t) => {
    const { app, store } = makeApp(t, {
        fetchFn: async () => { throw new Error('Wikidata API HTTP 503'); },
    });
    seed(store, 'Q1');

    const res = await post(app, `/api/findings/${firstId(store)}/confirm`);
    // Distinguishable from "this server is broken": the client should try again, and the row is
    // untouched so trying again is safe.
    assert.equal(res.statusCode, 503);
    assert.ok(!res.body.includes('HTTP 503') || !res.body.includes('at '), 'no stack trace');
    assert.equal(store.listFindings({ kind: 'image' })[0].status, 'open');
});

test('skipping settles a finding and clears its pick', async (t) => {
    const { app, store } = makeApp(t);
    seed(store, 'Q1');
    store.recordUpload({ destFile: 'A.jpg', qid: 'Q1' });
    store.setP18Pick('Q1', 'A.jpg');

    const res = await post(app, `/api/findings/${firstId(store)}/skip`, { reason: 'no category' });
    assert.equal(res.statusCode, 200);
    assert.equal(res.json().status, 'skipped');
    assert.deepEqual(store.p18Picks(), {});
    assert.ok(store.skipQids('image').has('Q1'), 'and discovery will not offer it again');
});

test('POST /findings/:id/pick flips an ambiguous finding to open with the chosen candidate', async (t) => {
    const { app, store } = makeApp(t);
    store.upsertTaxon({ qid: 'Q9', taxonName: 'Grania' });
    store.recordFinding({
        qid: 'Q9', kind: 'link', status: 'ambiguous',
        payload: { candidates: [
            { inatId: '111', rank: 'genus', evidence: { matches: 3, mismatches: 0, matchedRanks: ['family', 'genus', 'order'] }, score: null, scoredBy: null },
        ] },
    });
    const id = store.listFindings({ kind: 'link', status: 'ambiguous' })[0].id;

    const res = await post(app, `/api/findings/${id}/pick`, { inatId: '111' });
    assert.equal(res.statusCode, 200);
    assert.equal(res.json().picked, true);
    assert.deepEqual((await app.inject('/api/findings?kind=link&status=open')).json().taxa.map(r => r.qid), ['Q9']);
});

test('POST /findings/:id/pick refuses a candidate that was never offered', async (t) => {
    const { app, store } = makeApp(t);
    store.upsertTaxon({ qid: 'Q9', taxonName: 'Grania' });
    store.recordFinding({
        qid: 'Q9', kind: 'link', status: 'ambiguous',
        payload: { candidates: [{ inatId: '111', rank: 'genus', evidence: { matches: 0, mismatches: 0, matchedRanks: [] }, score: null, scoredBy: null }] },
    });
    const id = store.listFindings({ kind: 'link', status: 'ambiguous' })[0].id;

    const res = await post(app, `/api/findings/${id}/pick`, { inatId: '999' });
    assert.equal(res.statusCode, 400);
    assert.equal(res.json().code, 'unknown_candidate');
});

test('an unknown finding id is a 404, not a silent success', async (t) => {
    const { app } = makeApp(t, { fetchFn: fakeApi('both') });
    assert.equal((await post(app, '/api/findings/999999/skip')).statusCode, 404);
    // Confirm reports it per-id rather than failing the whole batch.
    const [result] = (await post(app, '/api/findings/999999/confirm')).json().results;
    assert.equal(result.reason, 'not_found');
});

for (const [what, url, payload] of [
    ['a non-numeric id', '/api/findings/abc/confirm', {}],
    ['an empty bulk list', '/api/findings/confirm', { ids: [] }],
    ['an over-long bulk list', '/api/findings/confirm', { ids: Array.from({ length: 201 }, (_, i) => i + 1) }],
    ['an unknown body field', '/api/findings/confirm', { ids: [1], force: true }],
    // Note ajv coerces "1" to 1 by default, and that coercion is what makes the querystring's
    // integer limit/offset work at all — so the id cases worth pinning are the ones no coercion
    // can rescue.
    ['a zero id', '/api/findings/confirm', { ids: [0] }],
    ['a non-numeric id in the list', '/api/findings/confirm', { ids: [{}] }],
]) {
    test(`${what} is rejected`, async (t) => {
        const { app } = makeApp(t, { fetchFn: fakeApi('both') });
        assert.equal((await post(app, url, payload)).statusCode, 400);
    });
}

// ---- uploads and picks ----

test('an upload and a pick round-trip through the database', async (t) => {
    const { app, store } = makeApp(t);
    seed(store, 'Q1');

    await post(app, '/api/uploads',
        { destFile: 'Taxon Q1 - 42.jpg', qid: 'Q1', photoId: '42', taxonName: 'Taxon Q1', uploaded: true, p18: true });

    const body = (await app.inject('/api/uploads')).json();
    assert.equal(body.count, 1);
    assert.equal(body.uploads[0].destFile, 'Taxon Q1 - 42.jpg');
    // findingId comes over the wire because the app confirms picks by it: deriving it from the
    // rendered rows meant a paged worklist silently skipped every pick not on the visible page.
    const [finding] = store.openFindings('image');
    assert.deepEqual(body.picks.Q1,
        { destFile: 'Taxon Q1 - 42.jpg', taxonName: 'Taxon Q1', findingId: finding.id });
    assert.equal(store.p18Picks().Q1.destFile, 'Taxon Q1 - 42.jpg');
});

test('un-marking an upload also drops the pick that depended on it', async (t) => {
    const { app, store } = makeApp(t);
    seed(store, 'Q1');
    await post(app, '/api/uploads', { destFile: 'A.jpg', qid: 'Q1', uploaded: true, p18: true });

    await post(app, '/api/uploads', { destFile: 'A.jpg', qid: 'Q1', uploaded: false });

    assert.deepEqual((await app.inject('/api/uploads')).json().uploads, []);
    assert.deepEqual(store.p18Picks(), {}, 'a pick on a file no longer claimed uploaded is stale');
});

test('an upload for an unknown taxon is kept without the reference', async (t) => {
    const { app } = makeApp(t);
    // uploads.qid is a foreign key; a qid this database never had must not 500 the route, and
    // the filename is still worth keeping.
    const res = await post(app, '/api/uploads', { destFile: 'Orphan.jpg', qid: 'Q999999', uploaded: true });
    assert.equal(res.statusCode, 200);
    assert.equal((await app.inject('/api/uploads')).json().uploads[0].qid, null);
});

test('importing localStorage state never marks anything done by itself', async (t) => {
    const { app, store } = makeApp(t);
    seed(store, 'Q1');
    seed(store, 'Q2');
    const id = store.listFindings({ kind: 'image' }).find(f => f.qid === 'Q1').id;

    const res = await post(app, '/api/import', {
        done: ['Q1'],
        picks: { Q1: { file: 'Taxon Q1 - 42.jpg', category: 'Taxon Q1' } },
        uploaded: ['Taxon Q1 - 42.jpg', 'Taxon Q2 - 7.jpg'],
    });

    const body = res.json();
    assert.equal(body.uploads, 2);
    assert.equal(body.picks, 1);
    // The locally-"done" flag was written when a QuickStatements line was *copied*, which is no
    // evidence anyone pasted it. Importing it as truth would reproduce the very defect this
    // slice removes, so it comes back as work to confirm instead.
    assert.deepEqual(body.toConfirm, [id]);
    assert.equal(store.listFindings({ kind: 'image' }).length, 2, 'both still open');
});

test('importing is idempotent and recovers the photo id from the filename', async (t) => {
    const { app, store } = makeApp(t);
    seed(store, 'Q1');
    const payload = { uploaded: ['Ficus benjamina - 12345.jpg'] };

    await post(app, '/api/import', payload);
    await post(app, '/api/import', payload);

    const uploads = (await app.inject('/api/uploads')).json().uploads;
    assert.equal(uploads.length, 1, 'the same file imported twice is one row');
    assert.equal(uploads[0].photoId, '12345');
    assert.equal(uploads[0].taxonName, 'Ficus benjamina');
    assert.equal(store.listUploads()[0].qid, null);
});

test('an unparseable legacy filename is imported rather than dropped', async (t) => {
    const { app } = makeApp(t);
    await post(app, '/api/import', { uploaded: ['some old name.jpg'] });

    const [row] = (await app.inject('/api/uploads')).json().uploads;
    assert.equal(row.destFile, 'some old name.jpg');
    assert.equal(row.photoId, null, 'no photo id recoverable, and that is fine');
});

// ---- rate limiting ----

test('the rate limit covers the API and leaves static assets alone', async (t) => {
    const { app, store } = makeApp(t, { rateLimit: { max: 2, timeWindow: 60_000 } });
    seed(store, 'Q1');

    assert.equal((await app.inject('/api/findings')).statusCode, 200);
    assert.equal((await app.inject('/api/findings')).statusCode, 200);
    const limited = await app.inject('/api/findings');
    assert.equal(limited.statusCode, 429);
    assert.ok(limited.headers['retry-after'], 'a locked-out client must be told when to return');

    // The regression test for the lesson vue-commons-gallery learned the hard way: an app-wide
    // limiter trips on the asset burst of a single page load and locks the operator out.
    for (let i = 0; i < 10; i++) {
        assert.equal((await app.inject('/js/main.js')).statusCode, 200, `asset request ${i}`);
    }
});

// ---- static app ----

test('the app is served from the root as an ES-module page', async (t) => {
    const { app } = makeApp(t);
    const index = await app.inject('/');
    assert.equal(index.statusCode, 200);
    assert.match(index.headers['content-type'], /text\/html/);
    assert.match(index.body, /<script type="module" src="js\/main.js">/);

    const js = await app.inject('/js/main.js');
    // A wrong MIME type here is fatal: the browser refuses to evaluate the module at all.
    assert.match(js.headers['content-type'], /^(text|application)\/javascript/);
    assert.match((await app.inject('/css/styles.css')).headers['content-type'], /text\/css/);
});

test('the gallery page resolves with its query string', async (t) => {
    const { app } = makeApp(t);
    const res = await app.inject('/taxon.html?taxon_id=1&name=Panthera%20onca&qid=Q140');
    assert.equal(res.statusCode, 200);
    assert.match(res.body, /js\/gallery.js/);
});

test('paths outside the web root are not served', async (t) => {
    const { app } = makeApp(t);
    for (const url of ['/../package.json', '/%2e%2e/package.json', '/../../etc/passwd', '/.env']) {
        const res = await app.inject(url);
        assert.notEqual(res.statusCode, 200, `${url} must not be served`);
        assert.ok(!res.body.includes('wikidata-inat-checker'), `${url} must not leak repo content`);
    }
});

test('an unknown page 404s instead of falling back to the index', async (t) => {
    const { app } = makeApp(t);
    const res = await app.inject('/nope.html');
    assert.equal(res.statusCode, 404);
    // This is a multi-page app; an SPA fallback would turn every typo into a silently wrong page.
    assert.ok(!res.body.includes('<script type="module"'));
});

// ---- security headers ----

test('security headers cover both the API and the static app', async (t) => {
    const { app } = makeApp(t);
    for (const url of ['/', '/api/findings']) {
        const res = await app.inject(url);
        const csp = res.headers['content-security-policy'];
        assert.ok(csp, `${url} carries a CSP`);
        assert.match(csp, /script-src 'self'/);
        assert.match(csp, /script-src-attr 'none'/);
        // The thumbnails live on the open-data bucket, which is on no other host list.
        assert.match(csp, /inaturalist-open-data\.s3\.amazonaws\.com/);
        assert.match(csp, /connect-src [^;]*api\.inaturalist\.org/);
        // Would upgrade every same-origin asset to https the moment this is published on
        // plain http, and take the whole app down with it.
        assert.ok(!csp.includes('upgrade-insecure-requests'), `${url} must not upgrade requests`);
        assert.equal(res.headers['x-powered-by'], undefined);
        assert.equal(res.headers['strict-transport-security'], undefined);
    }
});
