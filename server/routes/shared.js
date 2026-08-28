// @ts-check
// What every API route plugin (discover.js, search.js, findings.js) sets up the same way before
// its own routes: the write guard, a per-IP rate limit, and a cache-control header saying a
// backlog read is never worth caching. Extracted because all three copied it verbatim.
import rateLimit from '@fastify/rate-limit';
import writeGuard from '../writeGuard.js';

/**
 * A taxon is either an iNat id or a name. The digits branch is load-bearing beyond parsing:
 * descendantInatIds interpolates the id into LIKE patterns, so `%` would match every row of a
 * 3M-row table and turn one request into hundreds of SPARQL queries. Shared by discovery's scope
 * and search's, for the same reason.
 */
export const TAXON_PATTERN = '^(\\d{1,12}|[\\p{L}][\\p{L}\\p{M} .×\'-]{0,119})$';

/**
 * Register the write guard, the shared rate limiter, and the no-store cache-control hook every
 * API plugin wants before its own routes.
 * @param {import('fastify').FastifyInstance} app
 * @param {{allowedHosts?: string[], rateLimit?: object}} opts
 */
export async function registerApiDefaults(app, opts = {}) {
    await app.register(writeGuard, { allowedHosts: opts.allowedHosts });
    await app.register(rateLimit, {
        max: Number(process.env.RATE_LIMIT_MAX ?? 120),
        timeWindow: process.env.RATE_LIMIT_WINDOW ?? '1 minute',
        keyGenerator: (req) => req.ip,
        skipOnError: false, // a broken limiter must fail closed, not wave everything through
        ...opts.rateLimit,
    });

    app.addHook('onSend', (_req, reply, _payload, done) => {
        reply.header('cache-control', 'no-store');
        done();
    });
}
