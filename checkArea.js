#!/usr/bin/env node
// @ts-check
import { HEADERS, sparql, createRateLimiter, qidFromUri, parseArgs, chunk } from './lib/utils.js';
import { generateAreaHTML } from './report/generateAreaHTML.js';

const INAT_API = 'https://api.inaturalist.org/v1';

/** GET a JSON endpoint, throwing on a non-ok status (clearer than a JSON parse error). */
async function getJson(url) {
    const r = await fetch(url, { headers: HEADERS });
    if (!r.ok) throw new Error(`iNat HTTP ${r.status}`);
    return r.json();
}

const args = parseArgs();
const lat    = parseFloat(args.lat);
const lng    = parseFloat(args.lng);
const radius = parseFloat(args.radius);

if (!Number.isFinite(lat) || !Number.isFinite(lng) || !Number.isFinite(radius) || radius <= 0) {
    console.error('Usage: node checkArea.js --lat <lat> --lng <lng> --radius <km>');
    console.error('Example: node checkArea.js --lat 48.147 --lng 11.589 --radius 10');
    process.exit(1);
}

/** Finds species observed in a geographic area that have Wikidata items lacking images. */
async function run() {
    const inatLimiter   = createRateLimiter(1100);
    const sparqlLimiter = createRateLimiter(500);

    // Step 1: all species with CC-licensed research-grade photos in the area
    console.log(`Querying iNat for species within ${radius} km of ${lat}, ${lng}...`);
    /** @type {{taxonId: string, taxonName: string, commonName: string, count: number}[]} */
    const species = [];
    let page = 1, total = Infinity;
    while (species.length < total) {
        await inatLimiter();
        const params = new URLSearchParams({
            lat: String(lat), lng: String(lng), radius: String(radius),
            quality_grade: 'research',
            per_page: '500',
            page: String(page++),
        });
        const data = await getJson(`${INAT_API}/observations/species_counts?${params}`);
        total = data.total_results;
        for (const r of data.results) {
            species.push({
                taxonId:    String(r.taxon.id),
                taxonName:  r.taxon.name,
                commonName: r.taxon.preferred_common_name ?? '',
                count:      r.count,
            });
        }
        if (page % 3 === 1 || species.length >= total) console.log(`  ${species.length}/${total} species fetched`);
        if (data.results.length === 0) break;
    }
    console.log(`iNat: ${species.length} species with research-grade observations in area`);

    // Step 2: check which have a Wikidata item (P3151) that lacks an image (P18)
    console.log('Checking Wikidata for items without images...');
    /** @type {Map<string, {wdUri: string, wdName: string}>} */
    const noImage = new Map();
    for (const batch of chunk(species, 200)) {
        await sparqlLimiter();
        const values = batch.map(s => `"${s.taxonId}"`).join(' ');
        const query = `SELECT ?item ?inatId ?taxonName WHERE {
  VALUES ?inatId { ${values} }
  ?item wdt:P3151 ?inatId .
  OPTIONAL { ?item wdt:P225 ?taxonName . }
  FILTER NOT EXISTS { ?item wdt:P18 ?img . }
}`;
        const bindings = await sparql(query);
        for (const b of bindings) {
            noImage.set(b.inatId.value, {
                wdUri:  b.item.value,
                wdName: b.taxonName?.value ?? '',
            });
        }
    }
    console.log(`Wikidata: ${noImage.size} items in area lack an image`);

    if (noImage.size === 0) {
        console.log('Nothing to report — all taxa in this area already have Wikidata images.');
        return;
    }

    // Step 3: fetch up to 3 sample observations per qualified taxon
    console.log('Fetching sample observations and latest dates...');
    const qualified = species.filter(s => noImage.has(s.taxonId));

    // TODO(area-enrichment): Steps 3a/3b enrich each qualified taxon with photos and a latest
    // date by querying 20 taxa at once against a FIXED result window (per_page 60 for photos,
    // 20 for dates). That window is shared across the whole batch, so when a few taxa dominate
    // the results the others get no rows back — the report then shows "no photo found" and a
    // blank date for taxa that DO have qualifying observations. (The taxa themselves are never
    // dropped: `qualified` comes from the fully-paginated Step 1 and is always rendered whole.)
    // The date column is worst-hit: 20 taxa share only 20 date rows, so up to 19 can come back
    // empty. Fix by fetching per taxon (one request each, or paginate until every taxon in the
    // batch is covered) rather than relying on a single shared window. See docs/area.md.

    // Step 3a — photos ordered by votes for best thumbnail quality
    /** @type {Map<string, {obsId: number, photoUrl: string}[]>} */
    const obsMap = new Map();
    for (const batch of chunk(qualified, 20)) {
        await inatLimiter();
        const ids = batch.map(s => s.taxonId).join(',');
        const params = new URLSearchParams({
            taxon_id: ids,
            lat: String(lat), lng: String(lng), radius: String(radius),
            quality_grade: 'research',
            per_page: '60',
            order_by: 'votes',
        });
        const data = await getJson(`${INAT_API}/observations?${params}`);
        for (const obs of data.results ?? []) {
            const tid = String(obs.taxon?.id);
            if (!obsMap.has(tid)) obsMap.set(tid, []);
            const bucket = obsMap.get(tid);
            if (bucket.length < 3 && obs.photos?.length) {
                const url = obs.photos[0].url.replace('square', 'small');
                bucket.push({ obsId: obs.id, photoUrl: url });
            }
        }
    }

    // Step 3b — latest observation date per taxon (ordered by observed_on desc)
    /** @type {Map<string, string>} */
    const latestDateMap = new Map();
    for (const batch of chunk(qualified, 20)) {
        await inatLimiter();
        const ids = batch.map(s => s.taxonId).join(',');
        const params = new URLSearchParams({
            taxon_id: ids,
            lat: String(lat), lng: String(lng), radius: String(radius),
            quality_grade: 'research',
            per_page: '20',
            order_by: 'observed_on',
            order: 'desc',
        });
        const data = await getJson(`${INAT_API}/observations?${params}`);
        for (const obs of data.results ?? []) {
            const tid = String(obs.taxon?.id);
            if (!latestDateMap.has(tid) && obs.observed_on)
                latestDateMap.set(tid, obs.observed_on);
        }
    }

    // Step 4: generate HTML
    generateAreaHTML({ lat, lng, radius, totalSpecies: species.length, qualified, noImage, obsMap, latestDateMap });
}

run().catch(err => {
    console.error('Fatal error:', err);
    process.exit(1);
});
