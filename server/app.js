// @ts-check
// The Fastify application: the static web/ app plus the read-only findings API, both same-origin.
//
// buildServer() takes an already-open store and does NOT listen — the factory pattern Fastify's
// testing guide recommends, and the seam this repo already uses (verifyOpenFindings(store, opts)):
// tests inject an in-memory database, server/index.js injects the real file. It must never close
// the store it was handed; server/index.js owns that lifetime.
//
// Threat model and the reasoning behind each header in docs/security.md.
import { fileURLToPath } from 'node:url';
import Fastify, { LogController } from 'fastify';
import helmet from '@fastify/helmet';
import fastifyStatic from '@fastify/static';
import findingsRoutes from './routes/findings.js';

const WEB_ROOT = fileURLToPath(new URL('../web/', import.meta.url));

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
 * @param {{store: any, logger?: any, rateLimit?: object, staticOptions?: object}} opts
 * @returns {import('fastify').FastifyInstance}
 */
export function buildServer({ store, logger = false, rateLimit, staticOptions } = {}) {
    const app = Fastify({
        logger,
        logController: new ApiOnlyLogController(),
        // No route accepts a body yet, so anything large is abuse. Set now so slice 4's POSTs
        // inherit a ceiling rather than needing someone to remember one.
        bodyLimit: 16 * 1024,
        // Never unconditionally true: X-Forwarded-For is client-controlled, so trusting it blindly
        // lets anyone bypass the rate limit by rotating a header. Set TRUST_PROXY to the proxy's
        // address (e.g. 127.0.0.1) only when something really does sit in front.
        trustProxy: process.env.TRUST_PROXY || false,
        requestTimeout: 30_000,
        routerOptions: {
            ignoreDuplicateSlashes: true,
            maxParamLength: 64, // nothing here has a long parameter; slice 4's :id is an integer
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
        // web/data/ is gitignored generated content that nothing fetches over HTTP any more, and
        // generateImagesJson writes taxa.json with a non-atomic writeFileSync a concurrent GET
        // could catch mid-write.
        allowedPath: (pathname) => !pathname.startsWith('/data/'),
        ...staticOptions,
    });

    app.register(findingsRoutes, { prefix: '/api', store, rateLimit });

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
