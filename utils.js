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

const SPARQL_ENDPOINT = 'https://query.wikidata.org/sparql';

/**
 * Executes a SPARQL query against Wikidata (JSON format) with exponential-backoff retry.
 * @param {string} query
 * @param {number} [retries]
 * @returns {Promise<object[]>} SPARQL result bindings
 */
export async function sparql(query, retries = 3) {
    const res = await fetch(wbk.sparqlQuery(query), { headers: HEADERS });
    if ((res.status === 502 || res.status === 503) && retries > 0) {
        const delay = (4 - retries) * 3000;
        console.warn(`SPARQL HTTP ${res.status}, retrying in ${delay / 1000}s...`);
        await new Promise(r => setTimeout(r, delay));
        return sparql(query, retries - 1);
    }
    if (!res.ok) throw new Error(`SPARQL HTTP ${res.status}`);
    const text = await res.text();
    // Some Wikidata string values contain literal C0 control characters (invalid JSON).
    const cleaned = text.replace(/[\x00-\x1F\x7F]/g, '');
    return JSON.parse(cleaned).results.bindings;
}

/**
 * Like sparql() but requests TSV — avoids JSON escaping bugs on large result sets.
 * Returns plain objects: { [varName]: stringValue | undefined }.
 * URIs come back as the full URI string; literals with surrounding quotes stripped.
 * @param {string} query
 * @param {number} [retries]
 * @returns {Promise<object[]>}
 */
export async function sparqlTSV(query, retries = 3) {
    // Raw endpoint URL without format= — wbk.sparqlQuery() adds format=json which
    // overrides the Accept header. Accept header only works without a format= param.
    const url = `${SPARQL_ENDPOINT}?query=${encodeURIComponent(query)}`;
    const res = await fetch(url, { headers: { ...HEADERS, 'Accept': 'text/tab-separated-values' } });
    if ((res.status === 429 || res.status === 502 || res.status === 503 || res.status === 504) && retries > 0) {
        const delay = res.status === 429 ? 30000 : (4 - retries) * 3000;
        console.warn(`SPARQL HTTP ${res.status}, retrying in ${delay / 1000}s...`);
        await new Promise(r => setTimeout(r, delay));
        return sparqlTSV(query, retries - 1);
    }
    if (!res.ok) throw new Error(`SPARQL HTTP ${res.status}`);
    const lines = (await res.text()).replace(/^﻿/, '').split(/\r?\n/);
    if (lines.length < 2) return [];
    const headers = lines[0].split('\t').map(h => h.replace(/^\?/, ''));
    const rows = [];
    for (const line of lines.slice(1)) {
        if (!line.trim()) continue;
        const cells = line.split('\t');
        const row = {};
        for (let i = 0; i < headers.length; i++) {
            const cell = (cells[i] ?? '').trim();
            if (!cell) continue;
            if (cell.startsWith('<')) {
                row[headers[i]] = cell.slice(1, -1);
            } else if (cell.startsWith('"')) {
                const last = cell.lastIndexOf('"');
                row[headers[i]] = cell.slice(1, last).replace(/\\"/g, '"').replace(/\\\\/g, '\\');
            } else {
                row[headers[i]] = cell;
            }
        }
        rows.push(row);
    }
    return rows;
}

/**
 * Parse --key value and --flag args from process.argv.
 * Returns { key: 'value' } for --key value pairs and { key: true } for bare --flag.
 * Non-flag tokens (no leading --) are ignored.
 * @param {string[]} [argv]
 * @returns {Record<string, string | true>}
 */
export function parseArgs(argv = process.argv.slice(2)) {
    const result = {};
    for (let i = 0; i < argv.length; i++) {
        const tok = argv[i];
        if (!tok.startsWith('--')) continue;
        const key = tok.slice(2);
        const next = argv[i + 1];
        if (next !== undefined && !next.startsWith('--')) {
            result[key] = next;
            i++;
        } else {
            result[key] = true;
        }
    }
    return result;
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
