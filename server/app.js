// @ts-check
// The Fastify application: the static web/ app plus the findings API — reads, the confirm/skip and
// uploads writes, search, and discovery — all same-origin.
//
// buildServer() takes an already-open store and does NOT listen — the factory pattern Fastify's
// testing guide recommends, and the seam this repo already uses (verifyOpenFindings(store, opts)):
// tests inject an in-memory database, server/index.js injects the real file. It must never close
// the store it was handed; server/index.js owns that lifetime.
//
// Threat model and the reasoning behind each header in docs/threat-model.md.
import { fileURLToPath } from 'node:url';
import Fastify, { LogController } from 'fastify';
import helmet from '@fastify/helmet';
import fastifyStatic from '@fastify/static';
import findingsRoutes from './routes/findings.js';
import discoverRoutes from './routes/discover.js';
import searchRoutes from './routes/search.js';
import { openTaxaDb } from '../lib/getInatTaxaDb.js';
import { createJobs } from './jobs.js';
import { createScheduledTopup } from './scheduledTopup.js';

const WEB_ROOT = fileURLToPath(new URL('../web/', import.meta.url));

/**
 * Opens the taxa index once and hands the same accessor to everyone who asks. Two plugins read it
 * — search on every query, discovery to validate a scope — and two handles on a 236 MB file is
 * waste, not isolation. A *failure* is not remembered: the index is built by running a checker
 * from a terminal, which must not also require a restart to take effect.
 * @param {() => any} open
 */
function createIndexProvider(open) {
    let index = null;
    return () => {
        if (!index) index = open();
        return index;
    };
}

/**
 * Hosts web/js/* talks to directly from the browser. Listed **without a scheme** so one policy
 * serves http://localhost and a future https:// deployment alike.
 */
const CONNECT_HOSTS = [
    'api.inaturalist.org',
    'www.inaturalist.org',
    'commons.wikimedia.org',
    'www.wikidata.org',
    'query.wikidata.org',
    'nominatim.openstreetmap.org',
];

/**
 * Where iNat photos actually live — *not* the same list as CONNECT_HOSTS. gallery.js rewrites the
 * API's photo.url, and openly-licensed photos are served from the open-data bucket (see
 * docs/commons-upload-dev.md). Miss it and every thumbnail is blocked while the page still "works".
 */
const IMG_HOSTS = [
    'inaturalist-open-data.s3.amazonaws.com',
    'static.inaturalist.org',
    'www.inaturalist.org',
    // OpenStreetMap's tile subdomains, for area.html's map — Leaflet itself is vendored (no
    // script-src/style-src change needed), but map tiles are always fetched live. CSP source
    // lists have no subdomain wildcard, so the three are named individually.
    'a.tile.openstreetmap.org',
    'b.tile.openstreetmap.org',
    'c.tile.openstreetmap.org',
];

/**
 * Log the API's request lines and stay silent about static assets: one page load is ~8 asset
 * requests, and two log lines each would bury the traffic actually worth reading.
 */
class ApiOnlyLogController extends LogController {
    isLogDisabled(req) {
        return !String(req.url ?? '').startsWith('/api');
    }
}

/**
 * @param {{store: any, logger?: any, rateLimit?: object, staticOptions?: object,
 *          allowedHosts?: string[], fetchFn?: (qids: string[]) => Promise<object>,
 *          jobs?: any, dbFile?: string, discoverEnabled?: boolean, openIndex?: () => any,
 *          topupConfig?: {enabled: boolean} & Record<string, any>, scheduledTopup?: any,
 *          fetchAreaSpeciesFn?: Function, fetchAreaCandidatesFn?: Function}} opts
 * @returns {import('fastify').FastifyInstance}
 */
export function buildServer({
    store, logger = false, rateLimit, staticOptions, allowedHosts, fetchFn,
    jobs, dbFile = 'data/findings.db', discoverEnabled = false, openIndex,
    topupConfig, scheduledTopup, fetchAreaSpeciesFn, fetchAreaCandidatesFn,
} = {}) {
    const app = Fastify({
        logger,
        logController: new ApiOnlyLogController(),
        // Set while the API was still read-only, so the write endpoints inherited a ceiling
        // rather than each choosing one. Nothing here posts anything large; a big body is abuse.
        bodyLimit: 16 * 1024,
        // Never unconditionally true: X-Forwarded-For is client-controlled, so trusting it blindly
        // lets anyone bypass the rate limit by rotating a header. Set TRUST_PROXY to the proxy's
        // address (e.g. 127.0.0.1) only when something really does sit in front.
        trustProxy: process.env.TRUST_PROXY || false,
        requestTimeout: 30_000,
        routerOptions: {
            ignoreDuplicateSlashes: true,
            maxParamLength: 64, // nothing here has a long parameter; the only one, :id, is an integer
        },
        onProtoPoisoning: 'error',
        onConstructorPoisoning: 'error',
        // Fastify's default is removeAdditional: true, which silently *drops* an unknown query
        // parameter instead of refusing it — so a typo like ?kinds=image would quietly return the
        // default worklist as if it had been asked for. Reject it instead.
        ajv: { customOptions: { removeAdditional: false } },
    });

    app.register(helmet, {
        contentSecurityPolicy: {
            useDefaults: false,
            directives: {
                'default-src': ["'self'"],
                'base-uri': ["'self'"],
                'script-src': ["'self'"],
                // The directive the delegated-listener refactor exists for: no onclick=/onchange=
                // anywhere, so this needs no 'unsafe-inline' escape hatch.
                'script-src-attr': ["'none'"],
                'style-src': ["'self'"],
                'img-src': ["'self'", 'data:', ...IMG_HOSTS],
                'connect-src': ["'self'", ...CONNECT_HOSTS],
                'font-src': ["'self'"],
                'object-src': ["'none'"],
                'frame-src': ["'none'"],
                'worker-src': ["'none'"],
                'form-action': ["'none'"],
                'frame-ancestors': ["'none'"],
                // upgrade-insecure-requests is deliberately absent. helmet sets it by default,
                // which is invisible on localhost and fatal the moment this is published on a
                // plain-http address: every same-origin asset gets upgraded to a port with no TLS.
            },
        },
        hsts: false, // whatever terminates TLS owns this; setting it here can outlive the deployment
        crossOriginEmbedderPolicy: false, // COEP would block iNat images, which carry no CORP header
        referrerPolicy: { policy: 'no-referrer' },
    });

    app.register(fastifyStatic, {
        root: WEB_ROOT, // resolved from this module, not from cwd
        prefix: '/',
        index: ['index.html'],
        list: false,
        serveDotFiles: false,
        redirect: false,
        etag: true,
        lastModified: true,
        // Nothing in web/ is content-hashed, so any positive max-age means a browser keeps running
        // last week's JavaScript against this week's API.
        maxAge: 0,
        ...staticOptions,
    });

    // fetchFn is the Wikidata seam lib/verify.js already established: injected here so the whole
    // application can be exercised over an in-memory database with no network.
    app.register(findingsRoutes, { prefix: '/api', store, rateLimit, allowedHosts, fetchFn });

    // One read-only handle on the taxa index, shared by the two plugins that read it. Failures are
    // deliberately not memoised: the index is built by running a checker from a terminal, and that
    // should start working without restarting the server.
    const sharedIndex = createIndexProvider(openIndex ?? openTaxaDb);
    app.register(searchRoutes, { prefix: '/api', store, openIndex: sharedIndex, rateLimit, allowedHosts });

    // Runs live in a forked child, so the server owns starting and stopping them but never does
    // the work. Injected in tests; created here otherwise.
    const runner = jobs ?? createJobs({ log: app.log });

    // The scheduled top-up (slice 5b) is just another caller of runner.start(), in-process — so it
    // needs no privilege mechanism of its own; it never goes over HTTP. Off unless configured, and
    // the request-volume hook it depends on is skipped entirely when it's off, so a server that
    // never sets TOPUP_ENABLED pays no extra write per request.
    const topup = topupConfig?.enabled
        ? (scheduledTopup ?? createScheduledTopup({
            store, jobs: runner, config: { ...topupConfig, dbFile }, log: app.log,
        }))
        : null;
    if (topup) {
        app.addHook('onResponse', async (req) => {
            const url = req.url ?? '';
            // Excludes discovery's own traffic (the POST that starts a run, and the client-side
            // status poll) so the scheduler's runs never bias the "quiet" signal they're built from.
            if (url.startsWith('/api') && !url.startsWith('/api/discover')) store.recordRequest();
        });
        topup.start();
    }

    app.register(discoverRoutes, {
        prefix: '/api', store, jobs: runner, dbFile, discoverEnabled, openIndex: sharedIndex,
        rateLimit, allowedHosts, scheduledTopup: topup, fetchAreaSpeciesFn, fetchAreaCandidatesFn,
    });
    // Before the store closes in server/index.js: a child still holding a write handle would
    // outlive the thing that is supposed to own it. The scheduler's own interval must stop first,
    // or a tick could try to start a new run against a store that is about to close.
    app.addHook('onClose', () => topup?.stop());
    app.addHook('onClose', () => runner.close());

    // Fastify's default 404 echoes the requested route back; this one does not.
    app.setNotFoundHandler((_req, reply) => {
        reply.status(404).type('text/plain').send('Not found');
    });

    // Fastify's default 500 includes err.message — and a node:sqlite error carries the absolute
    // path of the database. Client errors stay descriptive: they describe the caller's own input.
    app.setErrorHandler((err, req, reply) => {
        const status = err.statusCode ?? 500;
        if (err.validation || status < 500) {
            reply.status(status).send(err);
            return;
        }
        req.log.error({ err, url: req.url }, 'request failed');
        reply.status(500).send({ statusCode: 500, error: 'Internal Server Error' });
    });

    return app;
}
