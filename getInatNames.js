// @ts-check
import { chunk } from './generateWikitext.js';
import { createRateLimiter } from './utils.js';

/**
 * @typedef {{ locale: string, name: string }} LocaleName
 */

const BATCH_SIZE = 30;
const API_URL = 'https://api.inaturalist.org/v1/taxa';

const LOCALE_MAP = {
    'zh-CN': 'zh-hans',
    'zh-TW': 'zh-hant',
};

const rateLimit = createRateLimiter();

async function fetchBatch(inatIds) {
    await rateLimit();
    const q = new URLSearchParams({
        id: inatIds.join(','),
        all_names: 'true',
        per_page: String(inatIds.length)
    });
    const r = await fetch(`${API_URL}?${q}`);
    if (!r.ok) throw new Error(`iNat HTTP ${r.status}`);
    return r.json();
}

/**
 * @param {string[]} inatIds
 * @returns {Promise<Map<string, LocaleName[]>>} Map from iNat taxon ID → vernacular names
 */
export async function fetchInatNames(inatIds) {
    const result = new Map();
    const batches = chunk(inatIds, BATCH_SIZE);

    for (let i = 0; i < batches.length; i++) {
        try {
            const data = await fetchBatch(batches[i]);
            for (const taxon of data.results || []) {
                const id = String(taxon.id);
                const names = (taxon.names || [])
                    .filter(n => n.is_valid && n.locale !== 'sci' && n.locale !== 'und')
                    .map(n => ({ locale: LOCALE_MAP[n.locale] || n.locale, name: n.name }));
                result.set(id, names);
            }
        } catch (err) {
            console.error(`iNat names batch ${i + 1} error:`, err.message);
        }
        if ((i + 1) % 5 === 0 || i === batches.length - 1) {
            console.log(`iNat names: batch ${i + 1}/${batches.length}`);
        }
    }

    return result;
}
