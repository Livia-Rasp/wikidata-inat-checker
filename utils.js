import WBK from 'wikibase-sdk';

export const HEADERS = {
    'User-Agent': 'wikidata-inat-checker/1.0.0 (https://github.com/Livia-Rasp/wikidata-inat-checker)'
};

export const wbk = WBK({
    instance: 'https://www.wikidata.org',
    sparqlEndpoint: 'https://query.wikidata.org/sparql'
});

export function qidFromUri(uri) { return uri.split('/').pop(); }

export function escapeHtml(str) {
    return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

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
