// @ts-check
// Searching the backlog: which of the taxa already on the worklist are in this clade, with this
// IUCN status. A plain read — no privilege, no discovery, no outbound request of any kind. That
// separation is the point of the slice: looking is instant and free, fetching spends the operator's
// Wikimedia and iNaturalist budget, and one box that did both could only ever do the expensive one.
//
// **The taxa index is a nice-to-have here, not a dependency.** Discovery 503s without it because it
// genuinely cannot run; search can still match the names the findings database holds itself, so it
// degrades instead. That matters because this read surface is meant to become public, and because a
// checkout that has never run a CLI checker has no index at all.
import { IUCN_STATUS_QIDS } from '../../lib/utils.js';
import { openTaxaDb, TaxaIndexUnavailable } from '../../lib/getInatTaxaDb.js';
import { resolveTaxonId, DiscoveryError } from '../../lib/discover.js';
import { createBacklogIndex } from '../../lib/backlogIndex.js';
import { findingSchema } from './findings.js';
import { TAXON_PATTERN, registerApiDefaults } from './shared.js';

/** A prefix worth suggesting from. Two characters keeps the range bounded and the answers useful. */
const PREFIX_PATTERN = '^[\\p{L}][\\p{L}\\p{M} .×\'-]{0,119}$';

const MAX_LIMIT = 2000;
const MAX_SUGGEST = 10;

const taxonRecordSchema = {
    type: 'object',
    properties: {
        inatId: { type: 'string' },
        name: { type: 'string' },
        rank: { type: 'string' },
    },
};

/**
 * @param {import('fastify').FastifyInstance} app
 * @param {{store: any, rateLimit?: object, allowedHosts?: string[], openIndex?: () => any}} opts
 */
export default async function searchRoutes(app, opts) {
    const { store, openIndex = openTaxaDb } = opts;

    await registerApiDefaults(app, opts);

    /** The index if there is one, null if there is not. Never throws: absence is a mode here. */
    function taxaIndexOrNull() {
        try {
            return openIndex();
        } catch (err) {
            if (err instanceof TaxaIndexUnavailable) return null;
            throw err;
        }
    }

    /** One backlog index per (kind, index handle) — each kind's rows are a different scan, and the
     *  index is rebuilt only if the handle changes, i.e. after someone builds the taxa index
     *  without restarting the server. */
    const backlogByKind = new Map();
    let backlogTaxaDb;
    function backlogIndex(kind) {
        const taxaDb = taxaIndexOrNull();
        if (backlogTaxaDb !== taxaDb) { backlogByKind.clear(); backlogTaxaDb = taxaDb; }
        if (!backlogByKind.has(kind)) backlogByKind.set(kind, createBacklogIndex({ store, taxaDb, kind }));
        return { backlog: backlogByKind.get(kind), taxaDb };
    }

    app.get('/search', {
        schema: {
            querystring: {
                type: 'object',
                additionalProperties: false,
                properties: {
                    kind: { type: 'string', enum: ['image', 'name', 'link'], default: 'image' },
                    taxon: { type: 'string', pattern: TAXON_PATTERN },
                    iucn: { type: 'string', enum: Object.keys(IUCN_STATUS_QIDS) },
                    limit: { type: 'integer', minimum: 1, maximum: MAX_LIMIT, default: 500 },
                    offset: { type: 'integer', minimum: 0, default: 0 },
                },
            },
            response: {
                200: {
                    type: 'object',
                    properties: {
                        generated: { type: ['string', 'null'] },
                        // What was actually applied, so the client never has to guess whether its
                        // query survived: `degraded` means the clade could not be resolved and the
                        // taxon was matched as a name fragment instead.
                        degraded: { type: 'boolean' },
                        resolved: {
                            type: ['object', 'null'],
                            properties: {
                                inatId: { type: 'string' },
                                name: { type: ['string', 'null'] },
                                rank: { type: ['string', 'null'] },
                                lineage: { type: 'array', items: taxonRecordSchema },
                            },
                        },
                        composition: {
                            type: 'object',
                            properties: {
                                under: { ...taxonRecordSchema, type: ['object', 'null'] },
                                entries: {
                                    type: 'array',
                                    items: {
                                        type: 'object',
                                        properties: {
                                            ...taxonRecordSchema.properties,
                                            count: { type: 'integer' },
                                        },
                                    },
                                },
                            },
                        },
                        // Per-status counts for the clade in view, before the IUCN filter — what
                        // the chips label themselves with.
                        iucnCounts: {
                            type: 'object',
                            additionalProperties: { type: 'integer' },
                        },
                        total: { type: 'integer' },
                        count: { type: 'integer' },
                        limit: { type: 'integer' },
                        offset: { type: 'integer' },
                        taxa: { type: 'array', items: findingSchema },
                    },
                },
                // An ambiguous/unknown taxon name (DiscoveryError). `...err.details` varies by
                // code (e.g. `matches` for ambiguous_taxon), so this stays loose rather than
                // duplicating DiscoveryError's per-code shapes here.
                400: { type: 'object', additionalProperties: true },
            },
        },
    }, async (req, reply) => {
        const { kind, taxon, iucn, limit, offset } = /** @type {any} */ (req.query);
        const { backlog: index, taxaDb } = backlogIndex(kind);

        let taxonId = null;
        let resolved = null;
        let degraded = false;

        if (taxon) {
            if (taxaDb) {
                try {
                    taxonId = resolveTaxonId(taxon, taxaDb);
                } catch (err) {
                    if (err instanceof DiscoveryError) {
                        // Same codes and the same `matches` list discovery returns, so the app has
                        // one disambiguation prompt rather than two.
                        return reply.status(400).send({
                            statusCode: 400, error: 'Bad Request',
                            code: err.code, message: err.message, ...err.details,
                        });
                    }
                    throw err;
                }
                const rec = taxaDb.byId(taxonId);
                resolved = {
                    inatId: taxonId,
                    name: rec?.name ?? null,
                    rank: rec?.rank ?? null,
                    lineage: taxaDb.lineage(taxonId),
                };
            } else {
                degraded = true;
            }
        }

        const got = index.search({
            taxonId,
            iucn: iucn ?? null,
            nameLike: degraded ? taxon : null,
            limit, offset,
        });

        return {
            generated: store.latestRunAt(),
            degraded,
            resolved,
            composition: got.composition,
            iucnCounts: got.iucnCounts,
            total: got.total,
            count: got.rows.length,
            limit, offset,
            taxa: got.rows,
        };
    });

    app.get('/taxa/suggest', {
        schema: {
            querystring: {
                type: 'object',
                additionalProperties: false,
                properties: {
                    q: { type: 'string', pattern: PREFIX_PATTERN },
                    limit: { type: 'integer', minimum: 1, maximum: MAX_SUGGEST, default: MAX_SUGGEST },
                },
                required: ['q'],
            },
            response: {
                200: {
                    type: 'object',
                    properties: {
                        degraded: { type: 'boolean' },
                        matches: { type: 'array', items: taxonRecordSchema },
                    },
                },
            },
        },
    }, async (req) => {
        const { q, limit } = /** @type {any} */ (req.query);
        const taxaDb = taxaIndexOrNull();
        if (!taxaDb) return { degraded: true, matches: [] };
        return { degraded: false, matches: taxaDb.suggest(q, limit) };
    });
}
