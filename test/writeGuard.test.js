// @ts-check
// The guard has no authentication behind it, so these are the tests that stand between the write
// endpoints and any page on the internet a browser can be pointed at.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { createFindingsStore, migrate } from '../lib/db.js';
import { buildServer } from '../server/app.js';

function makeApp(t, opts = {}) {
    const db = new DatabaseSync(':memory:');
    migrate(db);
    const store = createFindingsStore(db);
    const app = buildServer({ store, ...opts });
    t.after(() => app.close());
    return { app, store };
}

/**
 * A write that the guard should let through, so a 403 can only have come from the guard.
 * The route itself does not exist yet at this point in the branch, so 404 means "guard passed".
 */
function write(app, headers = {}) {
    return app.inject({
        method: 'POST',
        url: '/api/findings/1/confirm',
        headers: { host: 'localhost:8080', ...headers },
        payload: {},
    });
}

const passed = (res) => res.statusCode !== 403;

test('a cross-site write is refused', async (t) => {
    const { app } = makeApp(t);
    for (const site of ['cross-site', 'same-site']) {
        const res = await write(app, { 'sec-fetch-site': site });
        assert.equal(res.statusCode, 403, `sec-fetch-site: ${site}`);
        // same-site is refused alongside cross-site: a sibling subdomain is still not us.
        assert.equal(res.json().reason, 'cross_site');
    }
});

test('the app\'s own writes pass', async (t) => {
    const { app } = makeApp(t);
    assert.ok(passed(await write(app, { 'sec-fetch-site': 'same-origin' })));
    assert.ok(passed(await write(app, { 'sec-fetch-site': 'none' })), 'a typed URL or a bookmark');
});

test('a mismatched Origin is refused when Sec-Fetch-Site is absent', async (t) => {
    const { app } = makeApp(t);
    // Plain-http origins and older browsers are not sent Sec-Fetch-Site, so Origin is the fallback.
    const bad = await write(app, { origin: 'http://evil.example' });
    assert.equal(bad.statusCode, 403);
    assert.equal(bad.json().reason, 'cross_origin');

    assert.ok(passed(await write(app, { origin: 'http://localhost:8080' })), 'our own origin');
    assert.equal((await write(app, { origin: 'not a url' })).json().reason, 'bad_origin');
});

test('a request with neither header is allowed — it is not a browser', async (t) => {
    const { app } = makeApp(t);
    // curl and scripts send neither; a browser always sends one on a write, and CSRF is a
    // browser-only attack. Refusing here would break every local tool and protect nothing.
    assert.ok(passed(await write(app)));
});

test('a foreign Host is refused, which is what stops DNS rebinding', async (t) => {
    const { app } = makeApp(t);
    // The attack a loopback bind does not prevent: a public page resolves its own hostname to
    // 127.0.0.1 and reaches this server through the victim's browser. The Host header is the
    // thing that still says evil.example when it happens.
    const res = await write(app, { host: 'evil.example', 'sec-fetch-site': 'same-origin' });
    assert.equal(res.statusCode, 403);
    assert.equal(res.json().reason, 'host_not_allowed');
});

test('loopback names are accepted, and ALLOWED_HOSTS adds to them without replacing them', async (t) => {
    const { app } = makeApp(t, { allowedHosts: ['inat.home.arpa'] });
    for (const host of ['localhost:8080', '127.0.0.1:8080', '[::1]:8080', 'inat.home.arpa']) {
        assert.ok(passed(await write(app, { host })), host);
    }
    assert.equal((await write(app, { host: 'other.home.arpa' })).statusCode, 403);
});

test('a write must be JSON', async (t) => {
    const { app } = makeApp(t);
    // Fastify parses text/plain by default, and a cross-origin HTML form can send exactly that
    // with no preflight — so the content type is part of the defence, not a formality.
    const res = await app.inject({
        method: 'POST',
        url: '/api/findings/1/confirm',
        headers: { host: 'localhost:8080', 'content-type': 'text/plain' },
        payload: 'ids=1',
    });
    assert.equal(res.statusCode, 403);
    assert.equal(res.json().reason, 'bad_content_type');
});

test('reads are never guarded', async (t) => {
    const { app } = makeApp(t);
    // The read API is meant to be public eventually; every guard case must leave an *ordinary*
    // GET alone. GET /discover/area is the one exception — see below — because unlike this route
    // it spends real external API budget on every call.
    for (const headers of [
        { 'sec-fetch-site': 'cross-site' },
        { origin: 'http://evil.example' },
        { host: 'evil.example' },
        { 'content-type': 'text/plain' },
    ]) {
        const res = await app.inject({
            method: 'GET',
            url: '/api/findings',
            headers: { host: 'localhost:8080', ...headers },
        });
        assert.equal(res.statusCode, 200, JSON.stringify(headers));
    }
});

test('GET /discover/area is NOT exempt like an ordinary read — costsBudget opts it back in', async (t) => {
    // Dropping the old loopback-peer check from this route (slice 10) would leave it with no
    // protection at all against a background cross-origin request, since GET is normally exempt
    // from everything below — this is the regression that must never come back.
    const { app } = makeApp(t, { discoverEnabled: true, dbFile: ':memory:' });

    const badHost = await app.inject({
        method: 'GET', url: '/api/discover/area?lat=1&lng=1&radius=1',
        headers: { host: 'evil.example' },
    });
    assert.equal(badHost.statusCode, 403);
    assert.equal(badHost.json().reason, 'host_not_allowed');

    const crossSite = await app.inject({
        method: 'GET', url: '/api/discover/area?lat=1&lng=1&radius=1',
        headers: { host: 'localhost:8080', 'sec-fetch-site': 'cross-site' },
    });
    assert.equal(crossSite.statusCode, 403);
    assert.equal(crossSite.json().reason, 'cross_site');
});

test('a same-origin GET /discover/area still succeeds', async (t) => {
    const { app } = makeApp(t, {
        discoverEnabled: true, dbFile: ':memory:',
        fetchAreaSpeciesFn: async () => new Map(),
        fetchAreaCandidatesFn: async function* () {},
    });
    const res = await app.inject({
        method: 'GET', url: '/api/discover/area?lat=1&lng=1&radius=1',
        headers: { host: 'localhost:8080', 'sec-fetch-site': 'same-origin' },
    });
    assert.equal(res.statusCode, 200);
});
