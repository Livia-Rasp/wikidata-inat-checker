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
 * Split an array into chunks of at most `n` elements.
 * @template T
 * @param {T[]} arr
 * @param {number} n
 * @returns {T[][]}
 */
export function chunk(arr, n) {
    const out = [];
    for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
    return out;
}

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
 * Parse a SPARQL TSV response body into plain row objects.
 * URIs come back as the full URI string; literals have surrounding quotes stripped.
 * @param {string} text
 * @returns {object[]}
 */
function parseSparqlTSV(text) {
    const lines = text.replace(/^﻿/, '').split(/\r?\n/);
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

/** Backoff delay (ms) for a retryable SPARQL HTTP status. */
function sparqlRetryDelay(status, retries) {
    return status === 429 ? 30000 : (4 - retries) * 3000;
}

/**
 * Like sparql() but requests TSV — avoids JSON escaping bugs on large result sets.
 * Returns plain objects: { [varName]: stringValue | undefined }.
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
        const delay = sparqlRetryDelay(res.status, retries);
        console.warn(`SPARQL HTTP ${res.status}, retrying in ${delay / 1000}s...`);
        await new Promise(r => setTimeout(r, delay));
        return sparqlTSV(query, retries - 1);
    }
    if (!res.ok) throw new Error(`SPARQL HTTP ${res.status}`);
    return parseSparqlTSV(await res.text());
}

/**
 * POST variant of sparqlTSV — required for queries too long for a GET URL
 * (e.g. large VALUES lists). Same TSV parsing and backoff behaviour.
 * @param {string} query
 * @param {number} [retries]
 * @returns {Promise<object[]>}
 */
export async function sparqlPost(query, retries = 3) {
    const res = await fetch(SPARQL_ENDPOINT, {
        method: 'POST',
        headers: {
            ...HEADERS,
            'Accept': 'text/tab-separated-values',
            'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: `query=${encodeURIComponent(query)}`,
    });
    if ((res.status === 429 || res.status === 502 || res.status === 503 || res.status === 504) && retries > 0) {
        const delay = sparqlRetryDelay(res.status, retries);
        console.warn(`SPARQL HTTP ${res.status}, retrying in ${delay / 1000}s...`);
        await new Promise(r => setTimeout(r, delay));
        return sparqlPost(query, retries - 1);
    }
    if (!res.ok) throw new Error(`SPARQL HTTP ${res.status}`);
    return parseSparqlTSV(await res.text());
}

const WD_API_ENDPOINT = 'https://www.wikidata.org/w/api.php';

/**
 * Exact result count from Wikidata's CirrusSearch backend (Elasticsearch).
 * Handles large filtered sets that WDQS/Blazegraph times out on.
 * @param {string} srsearch e.g. `haswbstatement:P31=Q16521 -haswbstatement:P3151`
 * @param {number} [retries]
 * @returns {Promise<number>}
 */
export async function cirrusCount(srsearch, retries = 3) {
    const params = new URLSearchParams({
        action: 'query', list: 'search', srsearch,
        srnamespace: '0', srlimit: '1', srinfo: 'totalhits', srprop: '', format: 'json',
    });
    const res = await fetch(`${WD_API_ENDPOINT}?${params}`, { headers: HEADERS });
    if (res.status === 429 && retries > 0) {
        console.warn('CirrusSearch HTTP 429, retrying in 30s...');
        await new Promise(r => setTimeout(r, 30000));
        return cirrusCount(srsearch, retries - 1);
    }
    if (!res.ok) throw new Error(`CirrusSearch HTTP ${res.status}`);
    const data = await res.json();
    return data.query.searchinfo.totalhits;
}

/** Escape a string for use inside a SPARQL "double-quoted" literal. */
function escapeSparqlString(s) {
    return s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
        .replace(/\n/g, '\\n').replace(/\r/g, '\\r').replace(/\t/g, '\\t');
}

/**
 * Enumerate Wikidata taxa (P31=Q16521) that carry one of `values` on
 * `valueProperty` but lack `absentProperty`, by querying Wikidata *by value* in
 * bounded VALUES POST batches. This sidesteps WDQS's inability to scan large
 * (millions of rows) filtered sets: each batch is an indexed property lookup.
 * Yields one row per matching item, exposing the matched value as `valueKey`.
 *
 * P141 is fetched via OPTIONAL and `iucnQid` is filtered in JS — adding
 * `?item wdt:P141 wd:<qid>` to the query makes WDQS pick a bad plan and time out.
 * @param {string[]} values
 * @param {{ valueProperty: string, absentProperty: string, valueKey: string, sparqlPostFn?: (q: string) => Promise<object[]>, batchSize?: number, iucnQid?: string | null, onBatch?: (done: number, total: number) => void }} opts
 * @returns {AsyncGenerator<{ wdUri: string, qid: string, iucnQid: string | null, [k: string]: string | null }>}
 */
export async function* fetchWdTaxaByValues(values, { valueProperty, absentProperty, valueKey, sparqlPostFn = sparqlPost, batchSize = 10000, iucnQid = null, onBatch }) {
    for (let i = 0; i < values.length; i += batchSize) {
        const batch = values.slice(i, i + batchSize);
        const vals = batch.map(v => `"${escapeSparqlString(v)}"`).join(' ');
        const rows = await sparqlPostFn(`SELECT ?item ?value ?iucn WHERE {
  VALUES ?value { ${vals} }
  ?item wdt:P31 wd:Q16521 .
  ?item wdt:${valueProperty} ?value .
  FILTER NOT EXISTS { ?item wdt:${absentProperty} ?x . }
  OPTIONAL { ?item wdt:P141 ?iucn . }
}`);
        for (const r of rows) {
            if (!r.item) continue;
            const rowIucn = r.iucn ? qidFromUri(r.iucn) : null;
            if (iucnQid && rowIucn !== iucnQid) continue;
            yield {
                wdUri: r.item,
                qid: qidFromUri(r.item),
                [valueKey]: r.value ?? '',
                iucnQid: rowIucn,
            };
        }
        if (onBatch) onBatch(Math.min(i + batchSize, values.length), values.length);
    }
}

/**
 * Wikidata taxa without P3151 whose P225 name is one of `names`. Thin wrapper over
 * {@link fetchWdTaxaByValues}; yields `{ wdUri, qid, taxonName, iucnQid }`.
 * @param {string[]} names
 * @param {{ sparqlPostFn?: (q: string) => Promise<object[]>, batchSize?: number, iucnQid?: string | null, onBatch?: (done: number, total: number) => void }} [opts]
 */
export function fetchWdTaxaByNames(names, opts = {}) {
    return fetchWdTaxaByValues(names, { ...opts, valueProperty: 'P225', absentProperty: 'P3151', valueKey: 'taxonName' });
}

/**
 * Wikidata taxa without P18 whose P3151 iNat ID is one of `ids`. Thin wrapper over
 * {@link fetchWdTaxaByValues}; yields `{ wdUri, qid, inatId, iucnQid }`.
 * @param {string[]} ids
 * @param {{ sparqlPostFn?: (q: string) => Promise<object[]>, batchSize?: number, iucnQid?: string | null, onBatch?: (done: number, total: number) => void }} [opts]
 */
export function fetchWdTaxaByInatIds(ids, opts = {}) {
    return fetchWdTaxaByValues(ids, { ...opts, valueProperty: 'P3151', absentProperty: 'P18', valueKey: 'inatId' });
}

/**
 * Enumerate Wikidata taxa (P31=Q16521) with a P3151 iNat ID and a given IUCN status
 * (P141=iucnQid) but no P18, via one direct SPARQL query. With P141 as the selective
 * constraint the no-P18 set is small (a few thousand to ~30k rows), so WDQS answers it
 * in seconds — unlike the unfiltered no-P18 set (~619k) which it cannot scan, and which
 * is why {@link fetchWdTaxaByInatIds} inverts the query to enumerate by iNat ID instead.
 * Prefer this whenever an IUCN status is specified. Yields `{ wdUri, qid, inatId, iucnQid }`.
 * @param {string} iucnQid
 * @param {{ sparqlFn?: (q: string) => Promise<object[]> }} [opts]
 * @returns {AsyncGenerator<{ wdUri: string, qid: string, inatId: string, iucnQid: string }>}
 */
export async function* fetchWdTaxaByIucn(iucnQid, { sparqlFn = sparqlTSV } = {}) {
    const rows = await sparqlFn(`SELECT ?item ?inatId WHERE {
  ?item wdt:P31 wd:Q16521 .
  ?item wdt:P3151 ?inatId .
  ?item wdt:P141 wd:${iucnQid} .
  FILTER NOT EXISTS { ?item wdt:P18 ?img . }
}`);
    for (const r of rows) {
        if (!r.item || !r.inatId) continue;
        yield { wdUri: r.item, qid: qidFromUri(r.item), inatId: r.inatId, iucnQid };
    }
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

/**
 * Parse a positive-integer `--limit` from parsed args, falling back to `fallback`.
 * @param {Record<string, string | true>} args
 * @param {number} fallback
 * @returns {number}
 */
export function parseLimit(args, fallback) {
    const n = Number.parseInt(/** @type {string} */ (args.limit), 10);
    return Number.isFinite(n) && n > 0 ? n : fallback;
}

/**
 * Wikidata rank QIDs → lowercase rank labels used in tree comparison and auto-filter.
 * Only ranks recognisable in this map are compared; others are treated as absent.
 * @type {Record<string, string>}
 */
export const WD_RANK_LABELS = {
    Q34740: 'genus', Q35409: 'family', Q2136103: 'superfamily',
    Q164280: 'subfamily', Q227936: 'tribe', Q3965313: 'subtribe',
    Q36602: 'order', Q5867051: 'subclass', Q37517: 'class',
};

/**
 * Compare WD and iNat ancestor chains by rank, replicating the green/red tree logic.
 * Returns counts of matching/mismatching ranks and the list of matching rank names.
 * @param {Array<{name: string, rankQid: string|null}>} wdChain
 * @param {Array<{name: string, rank: string}>} inatChain
 * @returns {{ matches: number, mismatches: number, matchedRanks: string[] }}
 */
export function compareAncestorTrees(wdChain, inatChain) {
    const wdByRank = new Map(
        (wdChain ?? [])
            .filter(e => e.rankQid && WD_RANK_LABELS[e.rankQid])
            .map(e => [WD_RANK_LABELS[e.rankQid], e.name.toLowerCase()])
    );
    const inatByRank = new Map(
        (inatChain ?? [])
            .filter(e => e.rank)
            .map(e => [e.rank.toLowerCase(), e.name.toLowerCase()])
    );
    let matches = 0, mismatches = 0;
    const matchedRanks = [];
    for (const [rank, wdName] of wdByRank) {
        const inatName = inatByRank.get(rank);
        if (inatName === undefined) continue;
        if (wdName === inatName) { matches++; matchedRanks.push(rank); }
        else mismatches++;
    }
    return { matches, mismatches, matchedRanks };
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

/** Reverse of IUCN_STATUS_QIDS: Wikidata QID → IUCN short code, for bucketing. */
export const IUCN_QID_TO_CODE = Object.fromEntries(
    Object.entries(IUCN_STATUS_QIDS).map(([code, qid]) => [qid, code])
);

/**
 * Parse --iucn <code> from parsed args. Exits with an error message if the code is unknown.
 * Returns { iucnArg: string|null, iucnQid: string|null }.
 * @param {Record<string, string | true>} args
 * @returns {{ iucnArg: string | null, iucnQid: string | null }}
 */
export function parseIucnArg(args) {
    const iucnArg = typeof args.iucn === 'string' ? args.iucn.toUpperCase() : null;
    const iucnQid = iucnArg ? IUCN_STATUS_QIDS[iucnArg] : null;
    if (iucnArg && !iucnQid) {
        console.error(`Unknown IUCN status "${iucnArg}". Valid codes: ${Object.keys(IUCN_STATUS_QIDS).join(', ')}`);
        process.exit(1);
    }
    return { iucnArg, iucnQid };
}

/**
 * Fetch the full Wikidata ancestor chain for each item in `items` via wdt:P171+.
 * Returns a Map<qid, {name, rankQid}[]> with chains in kingdom-first order.
 * @param {{ qid: string }[]} items
 * @param {(query: string) => Promise<object[]>} sparqlFn
 * @param {(uri: string) => string} qidFromUriFn
 * @param {(arr: any[], size: number) => any[][]} chunkFn
 * @returns {Promise<Map<string, {name: string, rankQid: string|null}[]>>}
 */
export async function fetchWdAncestorChains(items, sparqlFn, qidFromUriFn, chunkFn) {
    const treeMap = new Map();
    for (const batch of chunkFn(items, 50)) {
        const vals = batch.map(m => `wd:${m.qid}`).join(' ');
        const bindings = await sparqlFn(`SELECT ?item ?directParent ?ancestor ?ancestorName ?ancestorRank ?ancestorParent WHERE {
  VALUES ?item { ${vals} }
  OPTIONAL {
    ?item wdt:P171 ?directParent .
    ?item wdt:P171+ ?ancestor .
    ?ancestor wdt:P225 ?ancestorName .
    OPTIONAL { ?ancestor wdt:P105 ?ancestorRank . }
    OPTIONAL { ?ancestor wdt:P171 ?ancestorParent . }
  }
}`);
        const byItem = new Map();
        for (const b of bindings) {
            const item = b.item.value;
            if (!byItem.has(item)) byItem.set(item, { directParent: null, ancestors: new Map() });
            const d = byItem.get(item);
            if (b.directParent && !d.directParent) d.directParent = b.directParent.value;
            if (b.ancestor) d.ancestors.set(b.ancestor.value, {
                name:    b.ancestorName?.value ?? '',
                rankQid: b.ancestorRank?.value?.split('/').pop() ?? null,
                parent:  b.ancestorParent?.value ?? null,
            });
        }
        for (const [itemUri, { directParent, ancestors }] of byItem) {
            const chain = [];
            let cur = directParent;
            while (cur && ancestors.has(cur)) {
                const a = ancestors.get(cur);
                chain.push({ name: a.name, rankQid: a.rankQid });
                cur = a.parent;
            }
            treeMap.set(qidFromUriFn(itemUri), chain.reverse());
        }
    }
    return treeMap;
}
