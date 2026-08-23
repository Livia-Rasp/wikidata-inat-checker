// @ts-check
// Area as a discovery scope: species observed near a point, cross-referenced against Wikidata
// items that carry an iNaturalist id but no image — the exact same P3151-present/P18-absent test
// every other image-scope candidate goes through. fetchWdTaxaByInatIds already runs that test, so
// this does not re-implement it; it only supplies the area-specific candidate list — checkArea.js's
// former Step 1 — and yields rows in the same shape discover()'s recordBatch already reads.
import { reqInit, createRateLimiter, fetchWdTaxaByInatIds } from './utils.js';
import { DiscoveryError } from './discover.js';

const INAT_API = 'https://api.inaturalist.org/v1';

/** GET a JSON endpoint, throwing on a non-ok status (clearer than a JSON parse error). */
async function getJson(url) {
    const r = await fetch(url, reqInit());
    if (!r.ok) throw new Error(`iNat HTTP ${r.status}`);
    return r.json();
}

/**
 * lat/lng/radius are given together or not at all — `null` means "no area scope", not "area scope
 * with defaults". Mirrors resolveIucn's shape so discover() reads it the same way.
 * @param {{lat?: number|string|null, lng?: number|string|null, radius?: number|string|null}} [scope]
 * @returns {{lat: number, lng: number, radius: number} | null}
 */
export function resolveAreaScope(scope = {}) {
    const { lat, lng, radius } = scope;
    const given = [lat, lng, radius].filter((v) => v !== null && v !== undefined);
    if (given.length === 0) return null;
    if (given.length < 3) {
        throw new DiscoveryError('incomplete_area_scope',
            'An area scope needs lat, lng and radius together, not just some of them.');
    }
    const nLat = Number(lat), nLng = Number(lng), nRadius = Number(radius);
    if (!Number.isFinite(nLat) || nLat < -90 || nLat > 90) {
        throw new DiscoveryError('invalid_area_scope', 'lat must be a number between -90 and 90.');
    }
    if (!Number.isFinite(nLng) || nLng < -180 || nLng > 180) {
        throw new DiscoveryError('invalid_area_scope', 'lng must be a number between -180 and 180.');
    }
    if (!Number.isFinite(nRadius) || nRadius <= 0) {
        throw new DiscoveryError('invalid_area_scope', 'radius must be a positive number of kilometers.');
    }
    return { lat: nLat, lng: nLng, radius: nRadius };
}

/**
 * Every species with a research-grade observation in the area — deliberately no license filter,
 * unlike the image checker's other scopes: the point of an area scope is to go photograph these
 * yourself, not to find a photo that already exists.
 * @param {{lat: number, lng: number, radius: number}} area
 * @param {{inatLimiter?: () => Promise<void>, getJsonFn?: (url: string) => Promise<any>}} [opts]
 * @returns {Promise<Map<string, {taxonName: string, commonName: string, count: number}>>}
 */
async function fetchAreaSpecies({ lat, lng, radius }, opts = {}) {
    const { inatLimiter = createRateLimiter(1100), getJsonFn = getJson } = opts;
    const species = new Map();
    let page = 1, total = Infinity;
    while (species.size < total) {
        await inatLimiter();
        const params = new URLSearchParams({
            lat: String(lat), lng: String(lng), radius: String(radius),
            quality_grade: 'research', per_page: '500', page: String(page++),
        });
        const data = await getJsonFn(`${INAT_API}/observations/species_counts?${params}`);
        total = data.total_results;
        for (const r of data.results) {
            species.set(String(r.taxon.id), {
                taxonName: r.taxon.name,
                commonName: r.taxon.preferred_common_name ?? '',
                count: r.count,
            });
        }
        if (data.results.length === 0) break;
    }
    return species;
}

/**
 * Candidates for an area scope, shaped like fetchWdTaxaByInatIds's own output (`wdUri`, `qid`,
 * `inatId`, `iucnQid`) plus the iNat fields — `taxonName`, `commonName`, `count` — the standalone
 * report and the `/area` preview need but discover()'s recordBatch never reads (it derives the
 * recorded name from the generated wikitext draft, not from the candidate row). The candidate's own
 * `taxonName` is therefore iNat's name, not Wikidata's P225 — a deliberate simplification over the
 * area checker's original Step 2, which fetched P225 by hand; every other image-scope candidate
 * source already leaves the display name to the draft, and duplicating the SPARQL lookup here just
 * to prefer a name that discover() ignores was not worth a second query shape.
 * @param {{lat: number, lng: number, radius: number}} area
 * @param {{inatLimiter?: () => Promise<void>, getJsonFn?: (url: string) => Promise<any>,
 *           candidatesFn?: (ids: string[]) => AsyncIterable<any>}} [opts]
 */
export async function* fetchAreaCandidates(area, opts = {}) {
    const { candidatesFn = fetchWdTaxaByInatIds } = opts;
    const species = await fetchAreaSpecies(area, opts);
    for await (const row of candidatesFn([...species.keys()])) {
        const meta = species.get(row.inatId);
        yield {
            ...row,
            taxonName: meta?.taxonName ?? '',
            commonName: meta?.commonName ?? '',
            count: meta?.count ?? 0,
        };
    }
}
