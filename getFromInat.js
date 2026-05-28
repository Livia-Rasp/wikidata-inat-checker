import { JsonDB, Config } from 'node-json-db';

const db = new JsonDB(new Config("inattWDPhotoCache", false, true, ';'));

const BATCH_SIZE = 50;
const REQUEST_INTERVAL_MS = 1000;
const SAVE_EVERY_BATCH = 5;
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

    for (const taxonId of matched) {
        const wdUri = idToWd.get(taxonId);
        await db.push(';available;' + wdUri, true);
        await db.push(';inatTaxonId;' + wdUri, taxonId);
    }
    for (const taxonId of taxonIds) {
        await db.push(';done;' + taxonId, true);
    }
    return { matched: matched.size, queried: taxonIds.length };
}

export async function processInatIds(map, license = DEFAULT_LICENSE) {
    const todo = [];
    for (const [key, val] of map) {
        if (!(await db.exists(';done;' + key))) todo.push([key, val]);
    }
    console.log(`${todo.length} taxa to query (skipping ${map.size - todo.length} already done)`);

    const batches = [];
    for (let i = 0; i < todo.length; i += BATCH_SIZE) {
        batches.push(todo.slice(i, i + BATCH_SIZE));
    }

    const flushOnExit = async () => {
        await db.save();
        process.exit(0);
    };
    process.once('SIGINT', flushOnExit);

    let totalMatched = 0;
    for (let i = 0; i < batches.length; i++) {
        try {
            const { matched } = await processBatch(batches[i], license);
            totalMatched += matched;
        } catch (error) {
            console.error('batch', i + 1, 'error:', error.message);
        }
        if ((i + 1) % SAVE_EVERY_BATCH === 0 || i === batches.length - 1) {
            await db.save();
            console.log(`progress: batch ${i + 1}/${batches.length}, available so far: ${totalMatched}`);
        }
    }
}
