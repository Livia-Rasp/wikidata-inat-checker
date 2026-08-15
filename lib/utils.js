// @ts-check
import fs from 'fs';
import WBK from 'wikibase-sdk';
import pLimit from 'p-limit';
import { cachePath, ensureParentDir } from './paths.js';

/** @type {Record<string, string>} */
export const HEADERS = {
    'User-Agent': 'wikidata-inat-checker/1.0.0 (https://github.com/Livia-Rasp/wikidata-inat-checker)'
};

/**
 * Node's fetch has no default timeout, so a stalled connection hangs the caller forever — survivable
 * in a CLI run somebody is watching, not in a server-triggered run that nothing is watching.
 *
 * WDQS gets a longer budget than everything else because its own query limit is 60 s and it has been
 * markedly slower through 2026; a shorter timeout here would abandon queries the service intends to
 * answer.
 */
export const FETCH_TIMEOUT_MS = 30_000;
export const SPARQL_TIMEOUT_MS = 90_000;

/** Request options with a timeout and our User-Agent. @param {number} [ms] */
export function reqInit(ms = FETCH_TIMEOUT_MS, headers = HEADERS) {
    return { headers, signal: AbortSignal.timeout(ms) };
}

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

/** WDQS statuses worth retrying: rate-limited (429) and transient gateway errors. */
const RETRYABLE_STATUS = new Set([429, 502, 503, 504]);

/**
 * Runs `doFetch` and retries on transient errors with backoff, returning the ok Response.
 * Shared by sparql()/sparqlTSV()/sparqlPost() so they back off identically, and by the
 * Action API path in fetchEntitiesBatched(); `label` only names the service in messages.
 * @param {() => Promise<Response>} doFetch
 * @param {number} retries
 * @param {string} [label]
 * @returns {Promise<Response>}
 */
export async function fetchWithRetry(doFetch, retries, label = 'SPARQL') {
    const res = await doFetch();
    if (RETRYABLE_STATUS.has(res.status) && retries > 0) {
        const delay = sparqlRetryDelay(res.status, retries);
        console.warn(`${label} HTTP ${res.status}, retrying in ${delay / 1000}s...`);
        await new Promise(r => setTimeout(r, delay));
        return fetchWithRetry(doFetch, retries - 1, label);
    }
    if (!res.ok) throw new Error(`${label} HTTP ${res.status}`);
    return res;
}

/**
 * Executes a SPARQL query against Wikidata (JSON format) with exponential-backoff retry.
 * @param {string} query
 * @param {number} [retries]
 * @returns {Promise<object[]>} SPARQL result bindings
 */
export async function sparql(query, retries = 3) {
    const res = await fetchWithRetry(
        () => fetch(wbk.sparqlQuery(query), reqInit(SPARQL_TIMEOUT_MS)), retries);
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

const WD_API = 'https://www.wikidata.org/w/api.php';

/**
 * wbgetentities takes at most 50 ids per request (500 only for clients granted higher limits).
 * Wikimedia also asks callers to keep concurrent requests to 3 or fewer.
 */
export const ENTITY_BATCH = 50;
const ENTITY_CONCURRENCY = 3;

/**
 * Batch-fetches Wikidata entities via wbgetentities, chunked to the API's 50-id ceiling and
 * capped at 3 concurrent requests, and returns one merged `entities` object keyed by QID.
 *
 * `sitefilter` is a parameter rather than a constant on purpose: callers want different
 * sitelinks (the ancestor walk needs specieswiki, verification needs commonswiki), and a
 * shared widened filter would make every batch carry payload most callers never read.
 *
 * A well-formed but deleted or merged id comes back per-entity as `{id, missing: ''}`, so one
 * bad id does not fail its batch. A *malformed* id (out of range) does fail the whole request
 * with `no-such-entity`; QIDs sourced from Wikidata cannot hit that, so it surfaces as an error.
 *
 * @param {string[]} qids
 * @param {{props?: string, sitefilter?: string, languages?: string, redirects?: 'yes'|'no',
 *          concurrency?: number, batchSize?: number,
 *          fetchFn?: (qids: string[]) => Promise<object>}} [opts]
 * @returns {Promise<Record<string, any>>} merged entities, keyed by QID
 */
export async function fetchEntitiesBatched(qids, opts = {}) {
    const {
        props = 'claims|sitelinks',
        sitefilter,
        languages,
        redirects,
        concurrency = ENTITY_CONCURRENCY,
        batchSize = ENTITY_BATCH,
        fetchFn,
    } = opts;

    const doFetch = fetchFn ?? (async (batch) => {
        const params = {
            action: 'wbgetentities',
            ids: batch.join('|'),
            props,
            format: 'json',
            formatversion: '2',
        };
        if (sitefilter) params.sitefilter = sitefilter;
        if (languages) params.languages = languages;
        if (redirects) params.redirects = redirects;
        const res = await fetchWithRetry(
            () => fetch(`${WD_API}?${new URLSearchParams(params)}`, reqInit()),
            3, 'Wikidata API');
        return res.json();
    });

    const limit = pLimit(concurrency);
    const batches = chunk(qids, batchSize);
    const results = await Promise.all(batches.map(b => limit(() => doFetch(b))));

    const entities = {};
    for (const data of results) Object.assign(entities, data.entities || {});
    return entities;
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
    const res = await fetchWithRetry(
        () => fetch(url, { headers: { ...HEADERS, 'Accept': 'text/tab-separated-values' } }),
        retries);
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
    const res = await fetchWithRetry(() => fetch(SPARQL_ENDPOINT, {
        method: 'POST',
        headers: {
            ...HEADERS,
            'Accept': 'text/tab-separated-values',
            'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: `query=${encodeURIComponent(query)}`,
    }), retries);
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

// ---- Commons category existence (cached, soft-redirect aware) ----------------------
// Mirrors web/js/enrich.js (kept duplicated so web/ stays self-contained), but persists
// to a JSON file so existence checks are reused across runs.

const COMMONS_API = 'https://commons.wikimedia.org/w/api.php';
const COMMONS_CAT_CACHE_FILE = cachePath('cache-commons-cats.json');

// {{Category redirect}} and aliases, normalised (lowercased, spaces/_/- stripped).
const REDIRECT_TEMPLATES = new Set([
    'categoryredirect', 'seecat', 'catredirect', 'catredir', 'redirectcategory',
    'catred', 'redirectcat', 'ctr', 'catr',
]);

/**
 * Commons category title (no "Category:" prefix) → status: true = real category,
 * "<target>" = soft redirect to that title, false = missing/unusable. Lazily loaded from
 * disk; persist with saveCommonsCatCache().
 * @type {Record<string, boolean | string> | null}
 */
let catCache = null;

function ensureCatCache() {
    if (catCache) return catCache;
    try {
        catCache = JSON.parse(fs.readFileSync(COMMONS_CAT_CACHE_FILE, 'utf8'));
    } catch {
        catCache = {};
    }
    return catCache;
}

/** Persist the Commons category-existence cache to disk. */
export function saveCommonsCatCache() {
    if (catCache) fs.writeFileSync(ensureParentDir(COMMONS_CAT_CACHE_FILE), JSON.stringify(catCache, null, 2), 'utf8');
}

/**
 * If `wikitext` is a soft category redirect, return its target title (no "Category:"
 * prefix), "" if it redirects but the target is unparseable, or null if it is not a redirect.
 * @param {string} wikitext
 * @returns {string | null}
 */
function softRedirectTarget(wikitext) {
    const re = /\{\{\s*([^|}\n]+?)\s*(?:\|\s*([^|}\n]*))?[|}]/g;
    let m;
    while ((m = re.exec(wikitext))) {
        const name = m[1].toLowerCase().replace(/[ _-]/g, '');
        if (!REDIRECT_TEMPLATES.has(name)) continue;
        const target = (m[2] || '').replace(/^\s*\d+\s*=\s*/, '').replace(/^:?\s*Category:/i, '').trim();
        return target || '';
    }
    return null;
}

/**
 * Populate the cat cache (existence + soft-redirect target) for any not-yet-known titles,
 * batched (<=45 per request). Titles are bare category names (no "Category:" prefix).
 * @param {string[]} names
 */
export async function checkCommonsCategories(names) {
    const cache = ensureCatCache();
    const todo = [...new Set(names)].filter((n) => !(n in cache));
    for (const batch of chunk(todo, 45)) {
        try {
            const titles = batch.map((n) => 'Category:' + n).join('|');
            const params = new URLSearchParams({
                action: 'query', format: 'json',
                prop: 'revisions', rvprop: 'content', rvslots: 'main', titles,
            });
            const res = await fetch(`${COMMONS_API}?${params}`, { headers: HEADERS });
            if (!res.ok) throw new Error(`Commons API HTTP ${res.status}`);
            const data = await res.json();
            const back = new Map((data.query?.normalized || []).map((x) => [x.to, x.from]));
            const got = new Set();
            for (const p of Object.values(data.query?.pages || {})) {
                const requested = (back.get(p.title) || p.title).replace(/^Category:/, '');
                got.add(requested);
                if ('missing' in p) { cache[requested] = false; continue; }
                const text = p.revisions?.[0]?.slots?.main?.['*'] || '';
                const target = softRedirectTarget(text);
                // not a redirect → real cat (true); redirect with target → store target;
                // redirect with no parseable target → unusable (false).
                cache[requested] = target === null ? true : (target || false);
            }
            for (const n of batch) if (!got.has(n)) cache[n] = false;
        } catch (e) {
            console.warn(`Commons category check failed: ${e.message}`);
            // leave uncached; a later run retries
        }
    }
}

/**
 * Resolve a Commons category title through any soft-redirect chain to a real category, or
 * null if it (or its redirect target) doesn't exist. Warm the cache for candidate titles
 * with checkCommonsCategories() first to avoid one request per title.
 * @param {string} name
 * @param {number} [maxHops=3]
 * @returns {Promise<string | null>}
 */
export async function resolveCommonsCategory(name, maxHops = 3) {
    const cache = ensureCatCache();
    let cur = name;
    for (let i = 0; i <= maxHops; i++) {
        await checkCommonsCategories([cur]);
        const v = cache[cur];
        if (v === true) return cur;                        // real category
        if (typeof v === 'string') { cur = v; continue; }  // soft redirect → follow
        return null;                                       // missing/unusable
    }
    return null; // redirect chain too long — give up
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
 * Enumerate Wikidata taxa (P31=Q16521) that carry a value on `valueProperty` and a given
 * IUCN status (P141=iucnQid) but lack `absentProperty`, via one direct SPARQL query. With
 * P141 as the selective constraint the filtered set is small (a few thousand to ~30k rows),
 * so WDQS answers it in seconds — unlike the unfiltered absent-property sets (hundreds of
 * thousands to millions of rows) which it cannot scan, and which is why
 * {@link fetchWdTaxaByValues} inverts the query to enumerate by value instead.
 * Prefer this whenever an IUCN status is specified. Yields `{ wdUri, qid, [valueKey], iucnQid }`.
 * @param {string} iucnQid
 * @param {{ valueProperty: string, absentProperty: string, valueKey: string, sparqlFn?: (q: string) => Promise<object[]> }} opts
 * @returns {AsyncGenerator<{ wdUri: string, qid: string, iucnQid: string, [k: string]: string }>}
 */
export async function* fetchWdTaxaByIucn(iucnQid, { valueProperty, absentProperty, valueKey, sparqlFn = sparqlTSV }) {
    const rows = await sparqlFn(`SELECT ?item ?value WHERE {
  ?item wdt:P31 wd:Q16521 .
  ?item wdt:${valueProperty} ?value .
  ?item wdt:P141 wd:${iucnQid} .
  FILTER NOT EXISTS { ?item wdt:${absentProperty} ?x . }
}`);
    for (const r of rows) {
        if (!r.item || !r.value) continue;
        yield { wdUri: r.item, qid: qidFromUri(r.item), [valueKey]: r.value, iucnQid };
    }
}

/** {@link fetchWdTaxaByIucn} for the images target: P3151 present, P18 absent, an IUCN status. */
export function fetchWdImagesByIucn(iucnQid, opts = {}) {
    return fetchWdTaxaByIucn(iucnQid, { ...opts, valueProperty: 'P3151', absentProperty: 'P18', valueKey: 'inatId' });
}

/** {@link fetchWdTaxaByIucn} for the links target: P225 present, P3151 absent, an IUCN status. */
export function fetchWdLinksByIucn(iucnQid, opts = {}) {
    return fetchWdTaxaByIucn(iucnQid, { ...opts, valueProperty: 'P225', absentProperty: 'P3151', valueKey: 'taxonName' });
}

/**
 * Parse `--key value`, `--key=value`, and bare `--flag` args from process.argv.
 * Returns { key: 'value' } for the first two forms and { key: true } for a bare flag.
 * Non-flag tokens (no leading --) are ignored.
 * @param {string[]} [argv]
 * @returns {Record<string, string | true>}
 */
export function parseArgs(argv = process.argv.slice(2)) {
    const result = {};
    for (let i = 0; i < argv.length; i++) {
        const tok = argv[i];
        if (!tok.startsWith('--')) continue;
        const body = tok.slice(2);
        const eq = body.indexOf('=');
        if (eq !== -1) {                                  // --key=value (value may be empty)
            result[body.slice(0, eq)] = body.slice(eq + 1);
            continue;
        }
        const next = argv[i + 1];
        if (next !== undefined && !next.startsWith('--')) { // --key value
            result[body] = next;
            i++;
        } else {                                          // bare --flag
            result[body] = true;
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
