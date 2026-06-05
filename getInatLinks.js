import pLimit from 'p-limit';

const REQUEST_INTERVAL_MS = 250;   // 4 req/s sustained
const API_URL = 'https://api.inaturalist.org/v1/taxa';
const HEADERS = { 'User-Agent': 'wikidata-inat-checker/1.0.0 (https://github.com/Livia-Rasp/wikidata-inat-checker)' };

let nextSlot = 0;
async function rateLimit() {
    const now = Date.now();
    const slot = Math.max(now, nextSlot);
    nextSlot = slot + REQUEST_INTERVAL_MS;
    const wait = slot - now;
    if (wait > 0) await new Promise(resolve => setTimeout(resolve, wait));
}

async function searchByName(name) {
    await rateLimit();
    const q = new URLSearchParams({ q: name, is_active: 'true', per_page: '10' });
    const r = await fetch(`${API_URL}?${q}`, { headers: HEADERS });
    if (!r.ok) throw new Error(`iNat HTTP ${r.status}`);
    return r.json();
}

// Returns Map<taxonName, {inatId, rank} | null>
// null means: no result, or multiple conflicting exact matches (ambiguous)
export async function findInatIds(taxonNames) {
    const result = new Map();
    let done = 0;
    const limit = pLimit(4);

    await Promise.all(taxonNames.map(name => limit(async () => {
        try {
            const data = await searchByName(name);
            const exact = (data.results || []).filter(t => t.name === name);
            result.set(name, exact.length === 1
                ? { inatId: String(exact[0].id), rank: exact[0].rank }
                : null);
        } catch (err) {
            console.error(`iNat search error for "${name}":`, err.message);
            result.set(name, null);
        }
        done++;
        if (done % 10 === 0 || done === taxonNames.length) {
            console.log(`iNat search: ${done}/${taxonNames.length}`);
        }
    })));

    return result;
}
