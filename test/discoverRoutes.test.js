// @ts-check
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { createFindingsStore, migrate } from '../lib/db.js';
import { createTaxaAccessor, TaxaIndexUnavailable } from '../lib/getInatTaxaDb.js';
import { buildServer } from '../server/app.js';

function makeIndex() {
    const db = new DatabaseSync(':memory:');
    db.exec('CREATE TABLE taxa (taxon_id TEXT PRIMARY KEY, name TEXT NOT NULL, rank TEXT NOT NULL, ancestry TEXT);');
    const ins = db.prepare('INSERT INTO taxa VALUES (?, ?, ?, ?)');
    ins.run('47217', 'Orchidaceae', 'family', '1');
    ins.run('1', 'Plantae', 'kingdom', null);
    return createTaxaAccessor(db);
}

/** A jobs runner that records what it was asked to do. */
function fakeJobs(initial = { state: 'idle' }) {
    const calls = [];
    let record = { ...initial };
    return {
        calls,
        start(config) {
            calls.push({ start: config });
            if (record.state === 'running') return null;
            record = { state: 'running', phase: 'starting', runId: null, scope: config.scope };
            return record;
        },
        status: () => ({ ...record }),
        cancel(runId) {
            calls.push({ cancel: runId });
            if (record.state !== 'running') return { cancelled: false, reason: 'not_running' };
            if (runId != null && record.runId != null && runId !== record.runId) {
                return { cancelled: false, reason: 'stale_run_id' };
            }
            record = { state: 'cancelled' };
            return { cancelled: true };
        },
        close: async () => {},
        _set: (r) => { record = r; },
    };
}

function makeApp(t, opts = {}) {
    const db = new DatabaseSync(':memory:');
    migrate(db);
    const store = createFindingsStore(db);
    const jobs = opts.jobs ?? fakeJobs();
    const app = buildServer({
        store, jobs, discoverEnabled: true, openIndex: makeIndex, dbFile: ':memory:', ...opts,
    });
    t.after(() => app.close());
    return { app, store, jobs, db };
}

function fakeScheduledTopup(status = { quietHours: [2, 3], sampleDays: 10, ranToday: false, deadlineHour: 23 }) {
    return { start() {}, stop() {}, getStatus: () => status };
}

/** A request as the app's own page would make it, from a local peer. */
const post = (app, url, payload, headers = {}) => app.inject({
    method: 'POST',
    url,
    remoteAddress: '127.0.0.1',
    headers: { host: 'localhost:8080', 'sec-fetch-site': 'same-origin', ...headers },
    payload: payload ?? {},
});

test('a run starts and answers 202 with its status', async (t) => {
    const { app, jobs } = makeApp(t);
    const res = await post(app, '/api/discover', { iucn: 'VU', limit: 25 });

    assert.equal(res.statusCode, 202);
    assert.equal(res.json().state, 'running');
    assert.deepEqual(jobs.calls[0].start.scope, { taxon: null, iucn: 'VU', lat: null, lng: null, radius: null });
    assert.equal(jobs.calls[0].start.limit, 25);
});

test('a second run is refused while one is going', async (t) => {
    const { app } = makeApp(t);
    await post(app, '/api/discover', {});
    const res = await post(app, '/api/discover', {});

    assert.equal(res.statusCode, 409);
    assert.equal(res.json().code, 'already_running');
});

test('a taxon scope is validated before anything is forked', async (t) => {
    const { app, jobs } = makeApp(t);
    const res = await post(app, '/api/discover', { taxon: 'Nonexistentia' });

    assert.equal(res.statusCode, 400);
    assert.equal(res.json().code, 'unknown_taxon');
    // The name lookup is an indexed query on an already-open handle, so the 400 costs microseconds
    // — and nothing was started.
    assert.deepEqual(jobs.calls, []);
});

test('a known taxon is accepted', async (t) => {
    const { app } = makeApp(t);
    assert.equal((await post(app, '/api/discover', { taxon: 'Orchidaceae' })).statusCode, 202);
});

test('a well-formed area scope is accepted and reaches the runner whole', async (t) => {
    const { app, jobs } = makeApp(t);
    const res = await post(app, '/api/discover', { lat: 48.147, lng: 11.589, radius: 10 });

    assert.equal(res.statusCode, 202);
    assert.deepEqual(jobs.calls[0].start.scope, {
        taxon: null, iucn: null, lat: 48.147, lng: 11.589, radius: 10,
    });
});

for (const [what, body] of [
    ['a LIKE wildcard', { taxon: '%' }],
    ['an underscore wildcard', { taxon: '_' }],
    ['an over-long name', { taxon: 'x'.repeat(200) }],
    ['an unknown IUCN code', { iucn: 'ZZ' }],
    ['a prototype key', { iucn: 'constructor' }],
    ['an absurd limit', { limit: 99999 }],
    ['a zero limit', { limit: 0 }],
    ['an unknown field', { nope: 1 }],
    ['lat without lng/radius', { lat: 48 }],
    ['lng without lat/radius', { lng: 11 }],
    ['radius without lat/lng', { radius: 5 }],
    ['lat out of range', { lat: 200, lng: 11, radius: 5 }],
    ['lng out of range', { lat: 48, lng: 400, radius: 5 }],
    ['radius zero', { lat: 48, lng: 11, radius: 0 }],
    ['radius negative', { lat: 48, lng: 11, radius: -1 }],
    ['an area scope combined with a taxon', { lat: 48, lng: 11, radius: 5, taxon: 'Orchidaceae' }],
    ['an area scope combined with an IUCN code', { lat: 48, lng: 11, radius: 5, iucn: 'VU' }],
]) {
    test(`${what} is rejected by the schema`, async (t) => {
        const { app, jobs } = makeApp(t);
        assert.equal((await post(app, '/api/discover', body)).statusCode, 400, what);
        assert.deepEqual(jobs.calls, [], 'and nothing was started');
    });
}

test('a missing taxa index is a 503 that says what to do', async (t) => {
    const { app } = makeApp(t, {
        openIndex: () => { throw new TaxaIndexUnavailable('missing', 'Run a checker from a terminal.'); },
    });
    const res = await post(app, '/api/discover', { taxon: 'Orchidaceae' });

    // The server must never be the thing that downloads 189MB and rebuilds for minutes.
    assert.equal(res.statusCode, 503);
    assert.equal(res.json().code, 'taxa_index_unavailable');
});

test('discovery is off unless it is switched on', async (t) => {
    const { app, jobs } = makeApp(t, { discoverEnabled: false });
    const res = await post(app, '/api/discover', {});

    assert.equal(res.statusCode, 403);
    assert.equal(res.json().code, 'discover_disabled');
    assert.deepEqual(jobs.calls, []);
});

test('a non-local peer cannot spend the operator\'s API budget', async (t) => {
    const { app, jobs } = makeApp(t);
    const res = await app.inject({
        method: 'POST',
        url: '/api/discover',
        remoteAddress: '203.0.113.7',
        // Host is client-controlled, so forging it is trivial — which is exactly why the peer
        // address, not the Host header, is what gates a privileged route.
        headers: { host: 'localhost:8080', 'sec-fetch-site': 'same-origin' },
        payload: {},
    });

    assert.equal(res.statusCode, 403);
    assert.equal(res.json().reason, 'not_local');
    assert.deepEqual(jobs.calls, []);
});

test('status is readable by anyone, and says whether discovery is even on', async (t) => {
    const { app } = makeApp(t, { discoverEnabled: false });
    const res = await app.inject({ url: '/api/discover/status', remoteAddress: '203.0.113.7' });

    assert.equal(res.statusCode, 200);
    assert.equal(res.json().enabled, false);
    assert.equal(res.json().state, 'idle');
    assert.equal(res.headers['cache-control'], 'no-store');
});

test('status reports the last run once the live record is gone', async (t) => {
    const { app, store } = makeApp(t);
    const id = store.startRun('images', { iucn: 'CR' });
    store.finishRun(id, { scanned: 10, found: 2 });

    const body = (await app.inject('/api/discover/status')).json();
    assert.equal(body.lastRun.state, 'done');
    assert.equal(body.lastRun.found, 2);
    assert.deepEqual(body.lastRun.scope, { iucn: 'CR' });
});

test('status says which run kind produced the last result', async (t) => {
    const { app, store } = makeApp(t);
    const id = store.startRun('images', {}, 'schedule');
    store.finishRun(id, { scanned: 1, found: 1 });

    assert.equal((await app.inject('/api/discover/status')).json().lastRun.triggeredBy, 'schedule');
});

test('status has no topup block when scheduling is off', async (t) => {
    const { app } = makeApp(t);
    assert.equal((await app.inject('/api/discover/status')).json().topup, null);
});

test('status surfaces the scheduler\'s own status once top-up is configured', async (t) => {
    const scheduledTopup = fakeScheduledTopup();
    const { app } = makeApp(t, { topupConfig: { enabled: true }, scheduledTopup });

    const body = (await app.inject('/api/discover/status')).json();
    assert.deepEqual(body.topup, { quietHours: [2, 3], sampleDays: 10, ranToday: false, deadlineHour: 23 });
});

test('requests are logged for the scheduler once top-up is on, but never discovery\'s own traffic', async (t) => {
    const { app, db } = makeApp(t, { topupConfig: { enabled: true }, scheduledTopup: fakeScheduledTopup() });

    await app.inject({ url: '/api/discover/status' }); // discovery's own traffic — excluded
    await post(app, '/api/discover', {});              // also excluded
    await app.inject({ url: '/api/findings' });         // ordinary traffic — logged

    assert.equal(Number(db.prepare('SELECT COUNT(*) AS n FROM request_log').get().n), 1);
});

test('nothing is logged at all when top-up is off', async (t) => {
    const { app, db } = makeApp(t); // topupConfig unset
    await app.inject({ url: '/api/findings' });
    assert.equal(Number(db.prepare('SELECT COUNT(*) AS n FROM request_log').get().n), 0);
});

test('cancelling needs something to cancel, and the right run id', async (t) => {
    const jobs = fakeJobs();
    const { app } = makeApp(t, { jobs });

    assert.equal((await post(app, '/api/discover/cancel', {})).statusCode, 409);

    await post(app, '/api/discover', {});
    jobs._set({ state: 'running', runId: 9 });
    assert.equal((await post(app, '/api/discover/cancel', { runId: 3 })).statusCode, 409);
    assert.equal((await post(app, '/api/discover/cancel', { runId: 9 })).statusCode, 200);
});

test('cancelling is privileged too', async (t) => {
    const { app } = makeApp(t);
    const res = await app.inject({
        method: 'POST', url: '/api/discover/cancel', remoteAddress: '203.0.113.7',
        headers: { host: 'localhost:8080', 'sec-fetch-site': 'same-origin' }, payload: {},
    });
    assert.equal(res.statusCode, 403);
});
