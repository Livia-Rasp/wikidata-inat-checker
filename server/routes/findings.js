// @ts-check
// The findings API. Encapsulated as its own plugin for two reasons: the rate limiter registered
// here covers the API and *only* the API (an app-wide limiter trips on the burst of static assets
// one page load fires), and the write guard registered here covers every mutating route, including
// the ones later slices add.
import rateLimit from '@fastify/rate-limit';
import { STICKY_STATUSES, NEGATIVE_STATUSES } from '../../lib/db.js';
import { confirmFindings } from '../../lib/confirm.js';
import writeGuard from '../writeGuard.js';

/** The three finding kinds. Area is a discovery *scope* on `image`, not a fourth kind. */
const KINDS = ['image', 'name', 'link'];

/** Reused from lib/db.js rather than retyped, so a new status cannot go missing here. */
const STATUSES = [...STICKY_STATUSES, ...NEGATIVE_STATUSES];

/** Hard ceiling on one page. Every query blocks the event loop — node:sqlite is synchronous. */
const MAX_LIMIT = 2000;

/** Ids per bulk confirm. 200 is four Wikidata requests — polite, and one paste-sized batch. */
const MAX_CONFIRM_IDS = 200;

/**
 * Writes cost more than reads: a confirm spends Wikimedia's API budget, not just ours. Applied
 * per-route so it composes with the shared limiter above rather than replacing it.
 */
const WRITE_RATE_LIMIT = {
    max: Number(process.env.RATE_LIMIT_WRITE_MAX ?? 30),
    timeWindow: process.env.RATE_LIMIT_WINDOW ?? '1 minute',
};

const findingSchema = {
    type: 'object',
    properties: {
        id: { type: 'integer' },
        qid: { type: 'string' },
        kind: { type: 'string' },
        status: { type: 'string' },
        wdUri: { type: 'string' },
        // Nullable in the database and therefore nullable here: a bare 'string' would serialise
        // these as "" and silently corrupt the difference between unknown and empty.
        inatTaxonId: { type: ['string', 'null'] },
        taxonName: { type: ['string', 'null'] },
        iucn: { type: ['string', 'null'] },
        wikitext: { type: ['string', 'null'] },
    },
};

/**
 * @param {import('fastify').FastifyInstance} app
 * @param {{store: any, rateLimit?: object, allowedHosts?: string[],
 *          fetchFn?: (qids: string[]) => Promise<object>}} opts
 */
export default async function findingsRoutes(app, opts) {
    const { store } = opts;

    // Before any route: every non-GET request under /api passes the guard, including ones added
    // by later slices, and including the wildcard 404 below.
    await app.register(writeGuard, { allowedHosts: opts.allowedHosts });

    await app.register(rateLimit, {
        max: Number(process.env.RATE_LIMIT_MAX ?? 120),
        timeWindow: process.env.RATE_LIMIT_WINDOW ?? '1 minute',
        keyGenerator: (req) => req.ip,
        skipOnError: false, // a broken limiter must fail closed, not wave everything through
        ...opts.rateLimit,
    });

    // A backlog is worklist state; a cached copy is a worklist someone has already worked through.
    app.addHook('onSend', (_req, reply, _payload, done) => {
        reply.header('cache-control', 'no-store');
        done();
    });

    app.get('/findings', {
        schema: {
            querystring: {
                type: 'object',
                // Reject unknown parameters rather than ignoring them: ?kinds=image silently
                // returning images-under-the-default is worse than a 400.
                additionalProperties: false,
                properties: {
                    kind: { type: 'string', enum: KINDS, default: 'image' },
                    status: { type: 'string', enum: STATUSES, default: 'open' },
                    limit: { type: 'integer', minimum: 1, maximum: MAX_LIMIT, default: 500 },
                    offset: { type: 'integer', minimum: 0, default: 0 },
                },
            },
            response: {
                200: {
                    type: 'object',
                    properties: {
                        generated: { type: ['string', 'null'] },
                        total: { type: 'integer' },
                        count: { type: 'integer' },
                        limit: { type: 'integer' },
                        offset: { type: 'integer' },
                        taxa: { type: 'array', items: findingSchema },
                    },
                },
            },
        },
    }, async (req) => {
        const { kind, status, limit, offset } = /** @type {any} */ (req.query);
        const taxa = store.listFindings({ kind, status, limit, offset });
        return {
            generated: store.latestRunAt(),
            // total is what matched before paging: without it a truncated page reads as the
            // whole backlog, which is precisely the wrong thing to believe about a worklist.
            total: store.countFindings({ kind, status }),
            count: taxa.length,
            limit,
            offset,
            taxa,
        };
    });

    // ---- writes ----
    // All three sit behind the write guard registered above, and carry the tighter write budget.

    const confirmResultSchema = {
        type: 'object',
        properties: {
            id: { type: 'integer' },
            qid: { type: 'string' },
            status: { type: 'string' },
            confirmed: { type: 'boolean' },
            reason: { type: 'string' },
            image: { type: ['string', 'null'] },
            commonsCategory: { type: ['string', 'null'] },
            expectedFile: { type: ['string', 'null'] },
        },
    };

    /** Answers 503 rather than 500 when Wikidata is the thing that failed, leaving rows untouched. */
    const confirm = async (ids, reply) => {
        try {
            return { results: await confirmFindings(store, ids, { fetchFn: opts.fetchFn }) };
        } catch (err) {
            // A confirm that could not reach Wikidata has decided nothing. Saying so is the
            // difference between "try again" and "this server is broken".
            reply.log.warn({ err }, 'confirm could not reach Wikidata');
            return reply.status(503).send({
                statusCode: 503,
                error: 'Service Unavailable',
                message: 'Wikidata could not be reached; nothing was changed. Try again.',
            });
        }
    };

    app.post('/findings/:id/confirm', {
        config: { rateLimit: WRITE_RATE_LIMIT },
        schema: {
            params: {
                type: 'object',
                properties: { id: { type: 'integer', minimum: 1 } },
                required: ['id'],
            },
            response: { 200: { type: 'object', properties: { results: { type: 'array', items: confirmResultSchema } } } },
        },
    }, async (req, reply) => confirm([/** @type {any} */ (req.params).id], reply));

    app.post('/findings/confirm', {
        config: { rateLimit: WRITE_RATE_LIMIT },
        schema: {
            body: {
                type: 'object',
                additionalProperties: false,
                required: ['ids'],
                properties: {
                    ids: {
                        type: 'array',
                        minItems: 1,
                        maxItems: MAX_CONFIRM_IDS,
                        items: { type: 'integer', minimum: 1 },
                    },
                },
            },
            response: { 200: { type: 'object', properties: { results: { type: 'array', items: confirmResultSchema } } } },
        },
    }, async (req, reply) => confirm(/** @type {any} */ (req.body).ids, reply));

    app.post('/findings/:id/skip', {
        config: { rateLimit: WRITE_RATE_LIMIT },
        schema: {
            params: {
                type: 'object',
                properties: { id: { type: 'integer', minimum: 1 } },
                required: ['id'],
            },
            body: {
                type: 'object',
                additionalProperties: false,
                properties: { reason: { type: 'string', maxLength: 500 } },
            },
        },
    }, async (req, reply) => {
        const finding = store.getFinding(/** @type {any} */ (req.params).id);
        if (!finding) return reply.status(404).send({ statusCode: 404, error: 'Not Found' });

        store.markSkipped(finding.qid, finding.kind, /** @type {any} */ (req.body)?.reason);
        store.clearP18Pick(finding.qid);
        return { id: finding.id, qid: finding.qid, status: 'skipped' };
    });

    // Anything else under /api answers as JSON, and inside the rate-limited scope. Without these
    // the static wildcard at the root would field it and reply with a file-not-found page.
    const notFound = async (_req, reply) =>
        reply.status(404).send({ statusCode: 404, error: 'Not Found' });
    app.all('/', notFound);
    app.all('/*', notFound);
}
