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
        ['id', 'inatTaxonId', 'iucn', 'qid', 'status', 'taxonName', 'wdUri', 'wikitext']);
    assert.equal(row.qid, 'Q1');
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
