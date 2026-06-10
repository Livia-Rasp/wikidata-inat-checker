import pLimit from 'p-limit';
import { HEADERS, createRateLimiter } from './utils.js';

const API_URL = 'https://api.inaturalist.org/v1/taxa';

const rateLimit = createRateLimiter();

async function searchByName(name, retries = 3) {
    await rateLimit();
    const q = new URLSearchParams({ q: name, is_active: 'true', per_page: '10' });
    const r = await fetch(`${API_URL}?${q}`, { headers: HEADERS });
    if (r.status === 429 && retries > 0) {
        const retryAfter = Number(r.headers.get('Retry-After') || 10);
        console.warn(`iNat rate-limited, backing off ${retryAfter}s...`);
        await new Promise(resolve => setTimeout(resolve, retryAfter * 1000));
        return searchByName(name, retries - 1);
    }
    if (!r.ok) throw new Error(`iNat HTTP ${r.status}`);
    return r.json();
}

// Returns Map<taxonName, {inatId, rank} | null>
// null means: no result, or multiple conflicting exact matches (ambiguous)
export async function findInatIds(taxonNames) {
    const result = new Map();
    let done = 0;
    const limit = pLimit(1);

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
