const BATCH_SIZE = 200;
const REQUEST_INTERVAL_MS = 1000;
const PER_PAGE = 500;
const API_URL = 'https://api.inaturalist.org/v1/observations/species_counts';
const DEFAULT_LICENSE = 'cc0,cc-by,cc-by-sa';

async function fetchBatchPage(taxonIds, license, page) {
    const q = new URLSearchParams({
        taxon_id: taxonIds.join(','),
        photo_license: license,
        quality_grade: 'research',
        per_page: String(PER_PAGE),
        page: String(page)
    });
    const r = await fetch(API_URL + '?' + q);
    if (!r.ok) throw new Error(`iNat HTTP ${r.status}`);
    return r.json();
}

let nextSlot = 0;
async function rateLimit() {
    const now = Date.now();
    const slot = Math.max(now, nextSlot);
    nextSlot = slot + REQUEST_INTERVAL_MS;
    const wait = slot - now;
    if (wait > 0) await new Promise(resolve => setTimeout(resolve, wait));
}

async function processBatch(batch, license) {
    const taxonIds = batch.map(([k]) => k);
    const idToWd = new Map(batch);
    const querySet = new Set(taxonIds.map(String));

    const matched = new Set();
    let page = 1;
    while (true) {
        await rateLimit();
        const data = await fetchBatchPage(taxonIds, license, page);
        for (const r of data.results || []) {
            for (const anc of r.taxon.ancestor_ids || []) {
                const s = String(anc);
                if (querySet.has(s)) matched.add(s);
            }
        }
        if (page * PER_PAGE >= (data.total_results || 0)) break;
        page++;
    }

    return [...matched].map(taxonId => ({ wdUri: idToWd.get(taxonId), taxonId }));
}

export async function processInatIds(map, license = DEFAULT_LICENSE) {
    const todo = [...map];
    console.log(`Querying ${todo.length} taxa against iNat...`);

    const batches = [];
    for (let i = 0; i < todo.length; i += BATCH_SIZE) {
        batches.push(todo.slice(i, i + BATCH_SIZE));
    }

    const available = {};
    const inatTaxonIds = {};
    let totalMatched = 0;

    for (let i = 0; i < batches.length; i++) {
        try {
            const results = await processBatch(batches[i], license);
            for (const { wdUri, taxonId } of results) {
                available[wdUri] = true;
                inatTaxonIds[wdUri] = taxonId;
            }
            totalMatched += results.length;
        } catch (error) {
            console.error('batch', i + 1, 'error:', error.message);
        }
        if ((i + 1) % 5 === 0 || i === batches.length - 1) {
            console.log(`progress: batch ${i + 1}/${batches.length}, available so far: ${totalMatched}`);
        }
    }

    return { available, inatTaxonIds };
}
