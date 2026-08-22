// @ts-check
// Topping up the backlog from the app. One run at a time, in a forked child, polled for status.
//
// This is the most expensive thing the server can be asked to do — a run spends the operator's
// Wikimedia and iNaturalist API budget for minutes — so it is `privileged` (loopback peers only,
// see server/writeGuard.js) and off unless DISCOVER_ENABLED says otherwise.
import rateLimit from '@fastify/rate-limit';
import writeGuard from '../writeGuard.js';
import { IUCN_STATUS_QIDS } from '../../lib/utils.js';
import { openTaxaDb, TaxaIndexUnavailable, taxaIndexIsStale } from '../../lib/getInatTaxaDb.js';
import { resolveTaxonScope, DiscoveryError } from '../../lib/discover.js';

/**
 * A taxon is either an iNat id or a name. The digits branch is load-bearing beyond parsing:
 * descendantInatIds interpolates the id into LIKE patterns, so `%` would match every row of a
 * 3M-row table and turn one request into hundreds of SPARQL queries.
 */
const TAXON_PATTERN = '^(\\d{1,12}|[\\p{L}][\\p{L}\\p{M} .×\'-]{0,119})$';

/** Starting a run is far more expensive than reading its status; they do not share a budget. */
const START_RATE_LIMIT = { max: Number(process.env.RATE_LIMIT_DISCOVER_MAX ?? 6), timeWindow: '1 minute' };

/**
 * @param {import('fastify').FastifyInstance} app
 * @param {{store: any, jobs: any, dbFile: string, discoverEnabled?: boolean,
 *          openIndex?: () => any, scheduledTopup?: any}} opts
 */
export default async function discoverRoutes(app, opts) {
    const {
        store, jobs, dbFile, discoverEnabled = false, openIndex = openTaxaDb, scheduledTopup = null,
    } = opts;

    await app.register(writeGuard, { allowedHosts: opts.allowedHosts });
    await app.register(rateLimit, {
        max: Number(process.env.RATE_LIMIT_MAX ?? 120),
        timeWindow: process.env.RATE_LIMIT_WINDOW ?? '1 minute',
        keyGenerator: (req) => req.ip,
        skipOnError: false,
        ...opts.rateLimit,
    });

    app.addHook('onSend', (_req, reply, _payload, done) => {
        reply.header('cache-control', 'no-store');
        done();
    });

    /** The parent keeps a cheap read-only handle for validation: getAll() is an indexed lookup. */
    let index = null;
    function taxaIndex() {
        if (!index) index = openIndex();
        return index;
    }

    app.post('/discover', {
        config: { privileged: true, rateLimit: START_RATE_LIMIT },
        schema: {
            body: {
                type: 'object',
                additionalProperties: false,
                properties: {
                    taxon: { type: 'string', pattern: TAXON_PATTERN },
                    iucn: { type: 'string', enum: Object.keys(IUCN_STATUS_QIDS) },
                    limit: { type: 'integer', minimum: 1, maximum: 5000, default: 500 },
                    recheckAfter: { type: 'integer', minimum: 0, maximum: 3650 },
                },
            },
        },
    }, async (req, reply) => {
        if (!discoverEnabled) {
            return reply.status(403).send({
                statusCode: 403, error: 'Forbidden', code: 'discover_disabled',
                message: 'Discovery is off. Set DISCOVER_ENABLED=1 to allow this server to spend '
                    + 'your Wikidata and iNaturalist API budget.',
            });
        }
        // Claimed first and synchronously: with an await in front of this, two simultaneous
        // requests would both see an idle runner and both fork.
        const body = /** @type {any} */ (req.body) ?? {};
        const config = {
            scope: { taxon: body.taxon ?? null, iucn: body.iucn ?? null },
            limit: body.limit ?? 500,
            recheckAfter: body.recheckAfter,
            dbFile,
        };

        // Validate the scope here rather than in the child: a name lookup is an indexed query on
        // an already-open handle, so a 400 costs microseconds, while the expensive parts of the
        // scope (the descendant scan) stay where they cannot block the event loop.
        try {
            if (config.scope.taxon) resolveTaxonScope(config.scope.taxon, taxaIndex());
        } catch (err) {
            if (err instanceof TaxaIndexUnavailable) return indexUnavailable(reply, err);
            if (err instanceof DiscoveryError) {
                return reply.status(400).send({
                    statusCode: 400, error: 'Bad Request', code: err.code,
                    message: err.message, ...err.details,
                });
            }
            throw err;
        }

        const started = jobs.start(config);
        if (!started) {
            return reply.status(409).send({
                statusCode: 409, error: 'Conflict', code: 'already_running',
                message: 'A discovery run is already in progress.',
                status: jobs.status(),
            });
        }
        return reply.status(202).send(publicStatus(jobs.status(), store, discoverEnabled, scheduledTopup));
    });

    app.get('/discover/status', async () =>
        publicStatus(jobs.status(), store, discoverEnabled, scheduledTopup));

    app.post('/discover/cancel', {
        config: { privileged: true, rateLimit: START_RATE_LIMIT },
        schema: {
            body: {
                type: 'object',
                additionalProperties: false,
                properties: { runId: { type: 'integer', minimum: 1 } },
            },
        },
    }, async (req, reply) => {
        const result = jobs.cancel(/** @type {any} */ (req.body)?.runId ?? null);
        if (!result.cancelled) {
            return reply.status(409).send({
                statusCode: 409, error: 'Conflict', code: result.reason,
                message: result.reason === 'not_running'
                    ? 'Nothing is running.'
                    : 'That run id is not the one currently running.',
            });
        }
        return { cancelled: true, status: jobs.status() };
    });

    function indexUnavailable(reply, err) {
        return reply.status(503).send({
            statusCode: 503, error: 'Service Unavailable', code: err.code, message: err.message,
        });
    }
}

/**
 * What a caller may see: the live record when a run is in flight, the last run from the database
 * once it is over (the in-memory one dies with the process), and never a raw error message.
 */
function publicStatus(record, store, discoverEnabled, scheduledTopup) {
    const last = store.latestRun('images');
    return {
        enabled: discoverEnabled,
        indexStale: taxaIndexIsStale(),
        state: record.state,
        phase: record.phase,
        runId: record.runId,
        scope: record.scope,
        startedAt: record.startedAt,
        finishedAt: record.finishedAt,
        counts: record.counts,
        error: record.error,
        lastRun: last && {
            id: last.id, state: last.state, scope: last.scope,
            startedAt: last.startedAt, finishedAt: last.finishedAt,
            scanned: last.scanned, found: last.found, triggeredBy: last.triggeredBy,
        },
        // The only visibility an unattended scheduled run gets — this project has no alerting.
        topup: scheduledTopup ? scheduledTopup.getStatus() : null,
    };
}
