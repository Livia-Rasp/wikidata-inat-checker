// @ts-check
// The read-only findings API. Encapsulated as its own plugin for two reasons: the rate limiter
// registered here then covers the API and *only* the API (an app-wide limiter trips on the burst
// of static assets one page load fires), and the write endpoints of the next slice hang off this
// same resource behind whatever auth hook is added at this seam.
import rateLimit from '@fastify/rate-limit';
import { STICKY_STATUSES, NEGATIVE_STATUSES } from '../../lib/db.js';

/** The three finding kinds. Area is a discovery *scope* on `image`, not a fourth kind. */
const KINDS = ['image', 'name', 'link'];

/** Reused from lib/db.js rather than retyped, so a new status cannot go missing here. */
const STATUSES = [...STICKY_STATUSES, ...NEGATIVE_STATUSES];

/** Hard ceiling on one page. Every query blocks the event loop — node:sqlite is synchronous. */
const MAX_LIMIT = 2000;

const findingSchema = {
    type: 'object',
    properties: {
        id: { type: 'integer' },
        qid: { type: 'string' },
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
 * @param {{store: any, rateLimit?: object}} opts
 */
export default async function findingsRoutes(app, opts) {
    const { store } = opts;

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

    // Anything else under /api answers as JSON, and inside the rate-limited scope. Without these
    // the static wildcard at the root would field it and reply with a file-not-found page.
    const notFound = async (_req, reply) =>
        reply.status(404).send({ statusCode: 404, error: 'Not Found' });
    app.all('/', notFound);
    app.all('/*', notFound);
}
