#!/usr/bin/env node
// @ts-check
import { HEADERS, wbk, createRateLimiter, qidFromUri } from './utils.js';
import { chunk } from './generateWikitext.js';
import { generateAreaHTML } from './generateAreaHTML.js';

const INAT_API = 'https://api.inaturalist.org/v1';

const lat    = parseFloat(process.argv[2]);
const lng    = parseFloat(process.argv[3]);
const radius = parseFloat(process.argv[4]);

if (!Number.isFinite(lat) || !Number.isFinite(lng) || !Number.isFinite(radius) || radius <= 0) {
    console.error('Usage: node checkArea.js <lat> <lng> <radius_km>');
    console.error('Example: node checkArea.js 48.147 11.589 10');
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
            photo_license: 'cc0,cc-by,cc-by-sa',
            per_page: '500',
            page: String(page++),
        });
        const data = await fetch(`${INAT_API}/observations/species_counts?${params}`, { headers: HEADERS }).then(r => r.json());
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
    console.log(`iNat: ${species.length} species with CC photos in area`);

    // Step 2: check which have a Wikidata item (P3151) that lacks an image (P18)
    console.log('Checking Wikidata for items without images...');
    /** @type {Map<string, {wdUri: string, wdName: string}>} */
    const noImage = new Map();
    for (const batch of chunk(species, 200)) {
        await sparqlLimiter();
        const values = batch.map(s => `"${s.taxonId}"`).join(' ');
        const sparql = `SELECT ?item ?inatId ?taxonName WHERE {
  VALUES ?inatId { ${values} }
  ?item wdt:P3151 ?inatId .
  OPTIONAL { ?item wdt:P225 ?taxonName . }
  FILTER NOT EXISTS { ?item wdt:P18 ?img . }
}`;
        const res = await fetch(wbk.sparqlQuery(sparql), { headers: HEADERS });
        const { results: { bindings } } = await res.json();
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
    console.log('Fetching sample observations...');
    const qualified = species.filter(s => noImage.has(s.taxonId));
    /** @type {Map<string, {obsId: number, photoUrl: string}[]>} */
    const obsMap = new Map();
    for (const batch of chunk(qualified, 20)) {
        await inatLimiter();
        const ids = batch.map(s => s.taxonId).join(',');
        const params = new URLSearchParams({
            taxon_id: ids,
            lat: String(lat), lng: String(lng), radius: String(radius),
            quality_grade: 'research',
            photo_license: 'cc0,cc-by,cc-by-sa',
            per_page: '60',
            order_by: 'votes',
        });
        const data = await fetch(`${INAT_API}/observations?${params}`, { headers: HEADERS }).then(r => r.json());
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

    // Step 4: generate HTML
    generateAreaHTML({ lat, lng, radius, totalSpecies: species.length, qualified, noImage, obsMap });
}

run().catch(err => {
    console.error('Fatal error:', err);
    process.exit(1);
});
