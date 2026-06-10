// @ts-check
import WBK from 'wikibase-sdk';

/** @type {Record<string, string>} */
export const HEADERS = {
    'User-Agent': 'wikidata-inat-checker/1.0.0 (https://github.com/Livia-Rasp/wikidata-inat-checker)'
};

export const wbk = WBK({
    instance: 'https://www.wikidata.org',
    sparqlEndpoint: 'https://query.wikidata.org/sparql'
});

/**
 * @param {string} uri
 * @returns {string}
 */
export function qidFromUri(uri) { return uri.split('/').pop(); }

/**
 * @param {string | number} str
 * @returns {string}
 */
export function escapeHtml(str) {
    return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

/**
 * Returns an async function that enforces a minimum gap between calls.
 * Each caller should have its own instance so rate limits don't bleed across modules.
 * @param {number} [intervalMs=1000]
 * @returns {() => Promise<void>}
 */
export function createRateLimiter(intervalMs = 1000) {
    let nextSlot = 0;
    return async function rateLimit() {
        const now = Date.now();
        const slot = Math.max(now, nextSlot);
        nextSlot = slot + intervalMs;
        const wait = slot - now;
        if (wait > 0) await new Promise(resolve => setTimeout(resolve, wait));
    };
}

/** IUCN Red List P1813 short codes → Wikidata QIDs, for SPARQL P141 filtering. */
export const IUCN_STATUS_QIDS = {
    EX: 'Q237350',
    EW: 'Q239509',
    CR: 'Q219127',
    EN: 'Q96377276',
    VU: 'Q278113',
    NT: 'Q719675',
    LC: 'Q211005',
    DD: 'Q3245245',
    NE: 'Q3350324',
};
