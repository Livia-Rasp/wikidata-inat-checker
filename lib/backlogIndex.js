// @ts-check
// Filtering the backlog by clade, and describing what a clade's slice of it contains.
//
// The findings database knows each taxon's iNat id but nothing about where it sits in the tree,
// and the taxa index knows the tree but nothing about the backlog. This is the join, kept out of
// the route so it can be tested without HTTP.
//
// **It walks up, not down.** Given a clade, the obvious move is `descendantInatIds()` and a set
// intersection — which is what the roadmap called for. Measured, that is an unindexed scan of a
// 3M-row table: 452 ms and 21,973 ids for Orchidaceae, and ~1M ids for Insecta. Reading each
// *backlog* row's ancestry path instead is a primary-key read per row, 4.1 ms for 300 of them, and
// it scales with the backlog rather than with the tree. node:sqlite is synchronous, so in the
// server process that difference is blocked event loop — the very thing slice 5 forked a child to
// avoid. See docs/dev.md.

/** Child clades listed under a search; more than a dozen stops being a summary. */
const MAX_COMPOSITION = 12;

/**
 * @typedef {{inatId: string, name: string, rank: string, count: number}} CompositionEntry
 */

/**
 * @param {{
 *   store: {listFindings: Function, latestRunAt: Function},
 *   taxaDb: {ancestorIds: Function, byId: Function} | null,
 *   kind?: string, status?: string,
 * }} opts
 */
export function createBacklogIndex({ store, taxaDb, kind = 'image', status = 'open' }) {
    /** Ancestor ids per backlog taxon. Keyed by taxon, so it warms once over the backlog and every
     *  later clade query is set membership — unlike a per-clade cache, which pays the full price
     *  again for each new clade searched. */
    const ancestorCache = new Map();
    /** @type {any[] | null} */
    let rows = null;
    /** @type {string | null} */
    let rowsStamp = null;

    /** The backlog changes only when a run finishes, so that timestamp is the whole invalidation
     *  rule. A run in flight leaves finished_at NULL and is deliberately not visible yet. */
    function currentRows() {
        const stamp = store.latestRunAt();
        if (rows === null || stamp !== rowsStamp) {
            rows = store.listFindings({ kind, status });
            rowsStamp = stamp;
        }
        return rows;
    }

    /** @param {string | null} inatId @returns {string[]} */
    function ancestorsOf(inatId) {
        if (!inatId || !taxaDb) return [];
        let ids = ancestorCache.get(inatId);
        if (ids === undefined) {
            ids = taxaDb.ancestorIds(inatId);
            ancestorCache.set(inatId, ids);
        }
        return ids;
    }

    /**
     * The child clade a row sits in, one step below the searched taxon — the row's own taxon when
     * it is a direct member. Undefined when the row is not in the clade at all, or when the taxa
     * index cannot place it.
     * @param {any} row @param {string} taxonId
     */
    function childUnder(row, taxonId) {
        if (row.inatTaxonId === taxonId) return row.inatTaxonId;
        const ids = ancestorsOf(row.inatTaxonId);
        const at = ids.indexOf(taxonId);
        if (at === -1) return undefined;
        // The next id down the path, or the row itself when the row *is* the next step.
        return ids[at + 1] ?? row.inatTaxonId;
    }

    /** @param {any[]} matched @param {string} pivot @returns {Map<string, number>} */
    function childCounts(matched, pivot) {
        /** @type {Map<string, number>} */
        const counts = new Map();
        for (const row of matched) {
            const child = childUnder(row, pivot);
            if (child) counts.set(child, (counts.get(child) ?? 0) + 1);
        }
        return counts;
    }

    /**
     * What a clade's slice of the backlog is made of, one rank down — or further, when one rank
     * down is a single clade. Searching Plantae otherwise offers nothing to navigate into, because
     * every plant in the backlog is a vascular plant and that is a fact about botany, not a way
     * through the worklist. Descending to the first branch point is what makes the strip useful.
     *
     * @param {any[]} matched @param {string} taxonId
     * @returns {{under: {inatId: string, name: string, rank: string} | null, entries: CompositionEntry[]}}
     */
    function composition(matched, taxonId) {
        const none = { under: null, entries: [] };
        if (!taxaDb || matched.length === 0) return none;

        let pivot = taxonId;
        let counts = childCounts(matched, pivot);
        // Bounded because the ancestry path is: each step moves strictly down it.
        for (let guard = 0; counts.size === 1 && guard < 40; guard++) {
            const [only] = counts.keys();
            if (only === pivot) break;              // the single child is the clade itself: a leaf
            pivot = only;
            counts = childCounts(matched, pivot);
        }
        // Still one bar after descending: the same number written twice, so say nothing.
        if (counts.size < 2) return none;

        const rec = pivot === taxonId ? null : taxaDb.byId(pivot);
        return {
            under: rec ? { inatId: rec.inatId, name: rec.name, rank: rec.rank } : null,
            entries: [...counts.entries()]
                .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
                .slice(0, MAX_COMPOSITION)
                .map(([inatId, count]) => {
                    const child = taxaDb.byId(inatId);
                    return { inatId, name: child?.name ?? inatId, rank: child?.rank ?? '', count };
                }),
        };
    }

    return {
        /**
         * @param {{taxonId?: string|null, iucn?: string|null, nameLike?: string|null,
         *          limit?: number|null, offset?: number}} q
         * @returns {{rows: any[], total: number, iucnCounts: Record<string, number>,
         *            composition: {under: object|null, entries: CompositionEntry[]}}}
         */
        search({ taxonId = null, iucn = null, nameLike = null, limit = null, offset = 0 } = {}) {
            let matched = currentRows();

            if (taxonId) {
                matched = matched.filter(r =>
                    r.inatTaxonId === taxonId || ancestorsOf(r.inatTaxonId).includes(taxonId));
            }
            // The fallback when there is no taxa index to resolve a clade with: match the names
            // the findings database holds itself, so search degrades instead of failing.
            if (nameLike) {
                const needle = nameLike.toLowerCase();
                matched = matched.filter(r => (r.taxonName ?? '').toLowerCase().includes(needle));
            }
            // Counted *before* the IUCN filter, so the chips keep showing what the other statuses
            // hold while one of them is active. Without this the chips are guesswork: most of the
            // backlog carries no status at all, so clicking one is usually clicking into nothing.
            /** @type {Record<string, number>} */
            const iucnCounts = {};
            for (const r of matched) if (r.iucn) iucnCounts[r.iucn] = (iucnCounts[r.iucn] ?? 0) + 1;

            if (iucn) matched = matched.filter(r => r.iucn === iucn);

            const total = matched.length;
            const page = limit === null ? matched.slice(offset) : matched.slice(offset, offset + limit);
            return {
                rows: page, total, iucnCounts,
                composition: taxonId ? composition(matched, taxonId) : { under: null, entries: [] },
            };
        },

        /** Test seam: how much of the backlog the ancestor memo has had to look up. */
        stats() {
            return { rows: currentRows().length, cached: ancestorCache.size };
        },
    };
}
