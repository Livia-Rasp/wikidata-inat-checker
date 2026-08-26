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
 * @param {{taxon?: string|null, iucn?: string|null, lat?: number|string|boolean|null, lng?: number|string|boolean|null, radius?: number|string|boolean|null}} [scope]
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
    // A bare CLI flag (`--lat` with no value) parses to the boolean `true`, and Number(true) is 1 —
    // silently a plausible-looking latitude. Force it to NaN so it hits the same invalid-value
    // error as any other bad input, instead of resolving to a wrong-but-valid-looking area.
    const toNum = (v) => typeof v === 'boolean' ? NaN : Number(v);
    const nLat = toNum(lat), nLng = toNum(lng), nRadius = toNum(radius);
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
 * Exported (not just an internal step of {@link fetchAreaCandidates}) so a caller that also wants
 * the total species count — the checker's report says "N of M species lack an image" — can fetch
 * it once and hand the same map to fetchAreaCandidates, rather than paying for Step 1 twice.
 * `maxPages` bounds Step 1's own cost independent of `radius`: a biodiverse area can carry far
 * more species than a wide-but-sparse one, and this is the knob the `/area` preview route uses to
 * stay well inside the server's request timeout (it answers synchronously, unlike POST /discover,
 * which forks and returns before the real work starts). The CLI leaves it unbounded.
 * `onTotal` fires once, after the first page, with iNat's own `total_results` — the true species
 * count even when `maxPages` stops short of fetching all of them. Optional and side-channel rather
 * than a return-shape change, so the CLI (which just wants the Map) and the existing tests are
 * untouched.
 * @param {{lat: number, lng: number, radius: number}} area
 * @param {{inatLimiter?: () => Promise<void>, getJsonFn?: (url: string) => Promise<any>,
 *           maxPages?: number, onTotal?: (total: number) => void}} [opts]
 * @returns {Promise<Map<string, {taxonName: string, commonName: string, count: number}>>}
 */
export async function fetchAreaSpecies({ lat, lng, radius }, opts = {}) {
    const {
        inatLimiter = createRateLimiter(1100), getJsonFn = getJson,
        maxPages = Infinity, onTotal = () => {},
    } = opts;
    const species = new Map();
    let page = 1, total = Infinity;
    while (species.size < total && page <= maxPages) {
        await inatLimiter();
        const params = new URLSearchParams({
            lat: String(lat), lng: String(lng), radius: String(radius),
            quality_grade: 'research', per_page: '500', page: String(page++),
        });
        const data = await getJsonFn(`${INAT_API}/observations/species_counts?${params}`);
        total = data.total_results;
        if (page === 2) onTotal(total); // fires once, right after the first page's response
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
 *           candidatesFn?: (ids: string[]) => AsyncIterable<any>,
 *           species?: Map<string, {taxonName: string, commonName: string, count: number}>}} [opts]
 */
export async function* fetchAreaCandidates(area, opts = {}) {
    const { candidatesFn = fetchWdTaxaByInatIds, species: givenSpecies } = opts;
    const species = givenSpecies ?? await fetchAreaSpecies(area, opts);
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

/**
 * Up to 3 photos and the latest observation date, per taxon, near the same area. One request per
 * taxon rather than the batched `taxon_id=id1,id2,...` shape checkArea.js used to send 20 at a
 * time: that request returns one fixed-size window (60 rows for photos, 20 for dates) *shared*
 * across every taxon in the batch, ordered globally by votes or date — so taxa that do not
 * dominate that ordering come back with nothing, even when qualifying observations exist for them
 * (docs/area.md, formerly a documented "Known limitation"). Per-taxon requests cannot starve one
 * taxon on another's traffic, because there is nothing shared to starve.
 *
 * A deliberate simplification over the checker's original two-request shape (photos ordered by
 * votes, latest date ordered by observed_on separately): combined into one `observed_on desc`
 * request per taxon, taking the first result's date as the latest observation and up to 3 of the
 * same page's photos. That halves the request count this fix would otherwise cost, at the price of
 * picking recent photos rather than the most-faved ones — worth it given every request here is now
 * one taxon's worth of network round trip, serialized behind the same rate limiter as everything
 * else this module does.
 * @param {string[]} taxonIds
 * @param {{lat: number, lng: number, radius: number}} area
 * @param {{inatLimiter?: () => Promise<void>, getJsonFn?: (url: string) => Promise<any>}} [opts]
 * @returns {Promise<{obsMap: Map<string, {obsId: number, photoUrl: string}[]>, latestDateMap: Map<string, string>}>}
 */
export async function fetchAreaEnrichment(taxonIds, { lat, lng, radius }, opts = {}) {
    const { inatLimiter = createRateLimiter(1100), getJsonFn = getJson } = opts;
    const obsMap = new Map();
    const latestDateMap = new Map();

    for (const taxonId of taxonIds) {
        await inatLimiter();
        const params = new URLSearchParams({
            taxon_id: taxonId,
            lat: String(lat), lng: String(lng), radius: String(radius),
            quality_grade: 'research', per_page: '20', order_by: 'observed_on', order: 'desc',
        });
        const data = await getJsonFn(`${INAT_API}/observations?${params}`);
        const results = data.results ?? [];
        if (results[0]?.observed_on) latestDateMap.set(taxonId, results[0].observed_on);

        const photos = [];
        for (const obs of results) {
            if (photos.length >= 3) break;
            if (obs.photos?.length) photos.push({ obsId: obs.id, photoUrl: obs.photos[0].url.replace('square', 'small') });
        }
        if (photos.length) obsMap.set(taxonId, photos);
    }

    return { obsMap, latestDateMap };
}
