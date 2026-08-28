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

/**
 * A jobs runner that records what it was asked to do.
 * @param {{state: string, phase?: string, runId?: number|null, scope?: any}} [initial]
 */
function fakeJobs(initial = { state: 'idle' }) {
    const calls = [];
    /** @type {{state: string, phase?: string, runId?: number|null, scope?: any}} */
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

/**
 * A request as the app's own page would make it, from a local peer.
 * @param {import('fastify').FastifyInstance} app
 * @param {string} url
 * @param {Record<string, any>} [payload]
 * @param {Record<string, string>} [headers]
 */
const post = (app, url, payload, headers = {}) => app.inject({
    method: 'POST',
    url,
    remoteAddress: '127.0.0.1',
    headers: { host: 'localhost:8080', 'sec-fetch-site': 'same-origin', ...headers },
    payload: payload ?? {},
});

/** A GET as the app's own page would make it. `remoteAddress` no longer gates anything here (slice
 *  10 replaced the loopback-peer check with a token budget) — kept as a parameter only so tests can
 *  show the peer address genuinely does not matter any more. */
const get = (app, url, remoteAddress = '127.0.0.1') => app.inject({ method: 'GET', url, remoteAddress });

/** A fetchAreaCandidatesFn stub yielding rows shaped like fetchAreaCandidates's own output. */
function areaCandidatesFn(rows) {
    return async function* (_area, _opts) {
        for (const r of rows) yield { wdUri: `http://www.wikidata.org/entity/${r.qid}`, iucnQid: null, ...r };
    };
}

test('a run starts and answers 202 with its status', async (t) => {
    const { app, jobs } = makeApp(t);
    const res = await post(app, '/api/discover', { iucn: 'VU', limit: 25 });

    assert.equal(res.statusCode, 202);
    assert.equal(res.json().state, 'running');
    assert.deepEqual(jobs.calls[0].start.scope, { taxon: null, iucn: 'VU', lat: null, lng: null, radius: null });
    assert.equal(jobs.calls[0].start.limit, 25);
});

test('a links run passes tool through to the runner, and defaults to images without it', async (t) => {
    const { app, jobs } = makeApp(t);
    await post(app, '/api/discover', { tool: 'links', iucn: 'VU' });
    assert.equal(jobs.calls[0].start.tool, 'links');

    const { app: app2, jobs: jobs2 } = makeApp(t);
    await post(app2, '/api/discover', {});
    assert.equal(jobs2.calls[0].start.tool, 'images');
});

test('links discovery rejects an area scope — it has no area-scope equivalent', async (t) => {
    const { app, jobs } = makeApp(t);
    const res = await post(app, '/api/discover', { tool: 'links', lat: 48, lng: 11, radius: 5 });

    assert.equal(res.statusCode, 400);
    assert.equal(res.json().code, 'unsupported_scope_combination');
    assert.deepEqual(jobs.calls, []);
});

test('a names run passes tool through to the runner', async (t) => {
    const { app, jobs } = makeApp(t);
    await post(app, '/api/discover', { tool: 'names', iucn: 'VU' });
    assert.equal(jobs.calls[0].start.tool, 'names');
});

test('names discovery rejects an area scope — it has no area-scope equivalent', async (t) => {
    const { app, jobs } = makeApp(t);
    const res = await post(app, '/api/discover', { tool: 'names', lat: 48, lng: 11, radius: 5 });

    assert.equal(res.statusCode, 400);
    assert.equal(res.json().code, 'unsupported_scope_combination');
    assert.deepEqual(jobs.calls, []);
});

test('an unknown tool is rejected by the schema', async (t) => {
    const { app, jobs } = makeApp(t);
    assert.equal((await post(app, '/api/discover', { tool: 'notatool' })).statusCode, 400);
    assert.deepEqual(jobs.calls, []);
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

/** @type {[string, Record<string, any>][]} */
const badScopes = [
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
];

for (const [what, body] of badScopes) {
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

test('a non-local peer can start a run — cost is bounded by budget now, not by peer address', async (t) => {
    const { app, jobs } = makeApp(t);
    const res = await app.inject({
        method: 'POST',
        url: '/api/discover',
        remoteAddress: '203.0.113.7',
        headers: { host: 'localhost:8080', 'sec-fetch-site': 'same-origin' },
        payload: {},
    });

    assert.equal(res.statusCode, 202);
    assert.equal(jobs.calls.length, 1);
});

test('POST /discover draws from a shared daily budget, and refuses once it is spent', async (t) => {
    const jobs = fakeJobs();
    // A tiny bucket, so the test does not need 24 real requests to exhaust the production default.
    const { app } = makeApp(t, {
        jobs, budgetConfig: { discover: { capacity: 2, refillPerHour: 1 }, discover_area: { capacity: 120, refillPerHour: 5 } },
    });

    for (let i = 0; i < 2; i++) {
        const res = await post(app, '/api/discover', {});
        assert.equal(res.statusCode, 202, `draw ${i}`);
        jobs._set({ state: 'idle' }); // pretend each run finished, so the single-flight lock never gates this
    }

    const refused = await post(app, '/api/discover', {});
    assert.equal(refused.statusCode, 429);
    assert.equal(refused.json().code, 'budget_exhausted');
    assert.ok(refused.headers['retry-after'], 'a 429 needs Retry-After so a caller knows when to come back');
    assert.equal(jobs.calls.length, 2, 'the refused attempt never reached jobs.start()');
});

test('a run that loses the single-flight race refunds its drawn token', async (t) => {
    const jobs = fakeJobs({ state: 'running' }); // already running before the request arrives
    const { app, store } = makeApp(t, {
        jobs, budgetConfig: { discover: { capacity: 3, refillPerHour: 1 }, discover_area: { capacity: 120, refillPerHour: 5 } },
    });

    const res = await post(app, '/api/discover', {});
    assert.equal(res.statusCode, 409);
    assert.equal(store.discoverBudgetStatus('discover', { capacity: 3, refillPerHour: 1 }).tokensRemaining, 3,
        'the draw was refunded — a run that never started must not have spent a token');
});

// ---- GET /discover/area: a preview, not a run — reads live from iNat/Wikidata but writes nothing ----

test('a well-formed area preview returns the sample, sorted by count, with mayBeIncomplete', async (t) => {
    const { app } = makeApp(t, {
        fetchAreaSpeciesFn: async (_area, { onTotal }) => {
            onTotal(3);
            return new Map([
                ['1', { taxonName: 'A', commonName: '', count: 5 }],
                ['2', { taxonName: 'B', commonName: '', count: 50 }],
            ]);
        },
        fetchAreaCandidatesFn: areaCandidatesFn([
            { qid: 'Q1', inatId: '1', taxonName: 'A', commonName: '', count: 5 },
            { qid: 'Q2', inatId: '2', taxonName: 'B', commonName: '', count: 50 },
        ]),
    });
    const res = await get(app, '/api/discover/area?lat=48.147&lng=11.589&radius=10');

    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.equal(body.totalSpecies, 3);
    assert.equal(body.sampled, 2);
    assert.equal(body.mayBeIncomplete, true, 'the sample (2) did not cover the true total (3)');
    assert.deepEqual(body.qualified.map((q) => q.qid), ['Q2', 'Q1'], 'sorted by count, highest first');
});

test('mayBeIncomplete is false once the sample covers everything the area has', async (t) => {
    const { app } = makeApp(t, {
        fetchAreaSpeciesFn: async (_area, { onTotal }) => {
            onTotal(1);
            return new Map([['1', { taxonName: 'A', commonName: '', count: 5 }]]);
        },
        fetchAreaCandidatesFn: areaCandidatesFn([
            { qid: 'Q1', inatId: '1', taxonName: 'A', commonName: '', count: 5 },
        ]),
    });
    const res = await get(app, '/api/discover/area?lat=48.147&lng=11.589&radius=10');
    assert.equal(res.json().mayBeIncomplete, false);
});

for (const [what, qs] of [
    ['no lat', 'lng=11&radius=5'],
    ['no lng', 'lat=48&radius=5'],
    ['no radius', 'lat=48&lng=11'],
    ['lat out of range', 'lat=200&lng=11&radius=5'],
    ['radius over this route\'s tighter ceiling', 'lat=48&lng=11&radius=51'],
    ['radius zero', 'lat=48&lng=11&radius=0'],
    ['limit over the ceiling', 'lat=48&lng=11&radius=5&limit=501'],
]) {
    test(`area preview: ${what} is rejected by the schema`, async (t) => {
        const { app } = makeApp(t);
        assert.equal((await get(app, `/api/discover/area?${qs}`)).statusCode, 400, what);
    });
}

test('an area preview needs discovery switched on too', async (t) => {
    const { app } = makeApp(t, { discoverEnabled: false });
    const res = await get(app, '/api/discover/area?lat=48.147&lng=11.589&radius=10');
    assert.equal(res.statusCode, 403);
    assert.equal(res.json().code, 'discover_disabled');
});

test('a non-local peer can preview an area — cost is bounded by budget now, not by peer address', async (t) => {
    const { app } = makeApp(t, {
        fetchAreaSpeciesFn: async () => new Map(),
        fetchAreaCandidatesFn: areaCandidatesFn([]),
    });
    const res = await get(app, '/api/discover/area?lat=48.147&lng=11.589&radius=10', '203.0.113.7');
    assert.equal(res.statusCode, 200);
});

test('GET /discover/area draws from its own budget, separate from POST /discover\'s', async (t) => {
    const { app } = makeApp(t, {
        budgetConfig: { discover: { capacity: 120, refillPerHour: 5 }, discover_area: { capacity: 1, refillPerHour: 1 } },
        fetchAreaSpeciesFn: async () => new Map(),
        fetchAreaCandidatesFn: areaCandidatesFn([]),
    });

    const first = await get(app, '/api/discover/area?lat=48.147&lng=11.589&radius=10');
    assert.equal(first.statusCode, 200);

    const refused = await get(app, '/api/discover/area?lat=48.147&lng=11.589&radius=10');
    assert.equal(refused.statusCode, 429);
    assert.equal(refused.json().code, 'budget_exhausted');
    assert.ok(refused.headers['retry-after']);
});

test('an area preview rejected by schema validation never draws a token', async (t) => {
    const { app, store } = makeApp(t, {
        budgetConfig: { discover: { capacity: 120, refillPerHour: 5 }, discover_area: { capacity: 1, refillPerHour: 1 } },
    });
    // radius=0 fails the schema (exclusiveMinimum), well before the handler ever calls
    // resolveAreaScope or draws a token.
    const res = await get(app, '/api/discover/area?lat=48.147&lng=11.589&radius=0');
    assert.equal(res.statusCode, 400);
    assert.equal(store.discoverBudgetStatus('discover_area', { capacity: 1, refillPerHour: 1 }).tokensRemaining, 1);
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

test('status?tool=links reports the links run history separately from images', async (t) => {
    const { app, store } = makeApp(t);
    const imgId = store.startRun('images', {}, 'manual');
    store.finishRun(imgId, { scanned: 1, found: 1 });
    const linkId = store.startRun('links', {}, 'manual');
    store.finishRun(linkId, { scanned: 5, found: 3 });

    const images = (await app.inject('/api/discover/status')).json();
    assert.equal(images.lastRun.found, 1);
    const links = (await app.inject('/api/discover/status?tool=links')).json();
    assert.equal(links.lastRun.found, 3);
});

test('status?tool=names reports the names run history separately from images and links', async (t) => {
    const { app, store } = makeApp(t);
    const imgId = store.startRun('images', {}, 'manual');
    store.finishRun(imgId, { scanned: 1, found: 1 });
    const nameId = store.startRun('names', {}, 'manual');
    store.finishRun(nameId, { scanned: 7, found: 4 });

    const names = (await app.inject('/api/discover/status?tool=names')).json();
    assert.equal(names.lastRun.found, 4);
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

test('cancelling from a non-local peer works too — it never spent any budget to begin with', async (t) => {
    const { app } = makeApp(t);
    const res = await app.inject({
        method: 'POST', url: '/api/discover/cancel', remoteAddress: '203.0.113.7',
        headers: { host: 'localhost:8080', 'sec-fetch-site': 'same-origin' }, payload: {},
    });
    // Nothing running, so 409 not_running — the point is it's not 403 any more.
    assert.equal(res.statusCode, 409);
    assert.equal(res.json().code, 'not_running');
});
