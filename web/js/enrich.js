// Async enrichment for the upload description: resolves place hierarchies, taxon ancestry,
// and the geographic-taxon + author Commons categories. Every external lookup is cached in
// localStorage (see cache.js) so we never repeat a query across photos/sessions.
//
// All endpoints used are CORS-open: iNaturalist API, Commons API, Wikidata Query Service.
import { Cache } from './cache.js';

const INAT = 'https://api.inaturalist.org/v1';
const COMMONS = 'https://commons.wikimedia.org/w/api.php';
const WDQS = 'https://query.wikidata.org/sparql';

const placeCache = new Cache('places');     // placeId  → { name, admin_level } | null
const ancestryCache = new Cache('ancestry'); // taxonId  → { self, ancestors, iconic }
const catCache = new Cache('catexists');     // title    → bool
const authorCache = new Cache('authorcat');  // userId   → [categoryName, …]

// iNat admin levels: 0 = country, 10 = state/region, 20 = county/district.
const ADMIN = { COUNTRY: 0, STATE: 10, COUNTY: 20 };

// Rank → specificity depth (deeper = more specific) for picking the geo category.
const RANK_DEPTH = {
    subspecies: 8, species: 7, genus: 6, subfamily: 5.5, family: 5,
    superfamily: 4.5, order: 4, class: 3, phylum: 2, kingdom: 1,
};

async function getJSON(url) {
    const r = await fetch(url, { headers: { Accept: 'application/json' } });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return r.json();
}
function chunk(arr, n) { const o = []; for (let i = 0; i < arr.length; i += n) o.push(arr.slice(i, i + n)); return o; }

// ---- places (§7.3) -----------------------------------------------------------------

/** Resolve & cache any not-yet-known place IDs via /v1/places (batched). */
export async function resolvePlaceIds(ids) {
    const todo = [...new Set(ids.map(String))].filter((id) => !placeCache.has(id));
    for (const batch of chunk(todo, 40)) {
        try {
            const data = await getJSON(`${INAT}/places/${batch.join(',')}`);
            const seen = new Set();
            for (const p of data.results || []) {
                seen.add(String(p.id));
                placeCache.set(String(p.id), { name: p.name, admin_level: p.admin_level });
            }
            for (const id of batch) if (!seen.has(id)) placeCache.set(id, null); // not a place / gone
        } catch { /* leave uncached; will retry next time */ }
    }
}

/** Build { county, state, country } names from an observation's place_ids (must be resolved). */
export function placeHierarchy(placeIds) {
    const out = { county: null, state: null, country: null };
    for (const id of placeIds || []) {
        const p = placeCache.get(String(id));
        if (!p) continue;
        if (p.admin_level === ADMIN.COUNTRY) out.country = p.name;
        else if (p.admin_level === ADMIN.STATE) out.state = p.name;
        else if (p.admin_level === ADMIN.COUNTY) out.county = p.name;
    }
    return out;
}

/** "County, State, Country" from present levels, or "" if none. */
export function locationString(h) {
    return [h.county, h.state, h.country].filter(Boolean).join(', ');
}

// ---- taxon ancestry (§7.6) ---------------------------------------------------------

export async function getAncestry(taxonId) {
    const key = String(taxonId);
    if (ancestryCache.has(key)) return ancestryCache.get(key);
    try {
        const data = await getJSON(`${INAT}/taxa/${key}?locale=en`);
        const t = data.results?.[0];
        if (!t) return ancestryCache.set(key, null);
        const ancestors = (t.ancestors || []).map((a) => ({
            name: a.name, rank: a.rank, common: a.preferred_common_name,
        }));
        const iconicAnc = ancestors.find((a) => a.name === t.iconic_taxon_name);
        const result = {
            self: { name: t.name, rank: t.rank },
            ancestors,
            iconic: iconicAnc?.common || null, // e.g. "Birds"
            iconicRank: iconicAnc?.rank || null,
            iconicName: t.iconic_taxon_name || null, // scientific, e.g. "Plantae" — for Flora/Fauna mapping
        };
        return ancestryCache.set(key, result);
    } catch { return null; }
}

// ---- Commons category existence + soft-redirect resolution (§7.6) -------------------
//
// Commons categories are categorised inconsistently by hand, with two traps for an
// automated "<Taxon> <prep> <Place>" guesser:
//  - Soft redirects: many cats exist only as {{Category redirect|<target>}} (e.g.
//    "Plants of Hawaii" → "Flora of Hawaii"). The page exists, so a plain existence check
//    treats it as valid and files images into a deprecated redirect. We must detect the
//    template and follow it to the real target.
//  - Preposition drift: kingdom-level uses "Flora/Animals of <Place>", but family-level
//    plant cats use "in" ("Fabaceae in Hawaii", with "...of Hawaii" missing). So we try
//    both prepositions and let existence decide.
//
// catCache stores, per title (no "Category:" prefix): false = missing/unusable,
// true = real category, "<target>" = soft redirect to that title.

// {{Category redirect}} and its aliases, normalised (lowercased, spaces/_/- stripped).
const REDIRECT_TEMPLATES = new Set([
    'categoryredirect', 'seecat', 'catredirect', 'catredir', 'redirectcategory',
    'catred', 'redirectcat', 'ctr', 'catr',
]);

/**
 * If `wikitext` is a soft category redirect, return its target title (no "Category:"
 * prefix), or "" if it redirects but the target is unparseable. Returns null if it is
 * not a redirect at all.
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

/** Populate catCache (existence + redirect target) for any not-yet-known titles, batched. */
async function loadCatInfo(names) {
    const todo = [...new Set(names)].filter((n) => !catCache.has(n));
    for (const batch of chunk(todo, 45)) {
        try {
            const titles = batch.map((n) => 'Category:' + n).join('|');
            const url = `${COMMONS}?${new URLSearchParams({
                action: 'query', format: 'json', origin: '*',
                prop: 'revisions', rvprop: 'content', rvslots: 'main', titles,
            })}`;
            const data = await getJSON(url);
            const back = new Map((data.query?.normalized || []).map((x) => [x.to, x.from]));
            const got = new Set();
            for (const p of Object.values(data.query?.pages || {})) {
                const requested = (back.get(p.title) || p.title).replace(/^Category:/, '');
                got.add(requested);
                if ('missing' in p) { catCache.set(requested, false); continue; }
                const text = p.revisions?.[0]?.slots?.main?.['*'] || '';
                const target = softRedirectTarget(text);
                // not a redirect → real cat (true); redirect with target → store target;
                // redirect with no parseable target → unusable (false).
                catCache.set(requested, target === null ? true : (target || false));
            }
            for (const n of batch) if (!got.has(n)) catCache.set(n, false);
        } catch { /* leave uncached; retry next time */ }
    }
}

/** Resolve a category title through any soft-redirect chain to a real category, or null. */
async function resolveCategory(name, maxHops = 3) {
    let cur = name;
    for (let i = 0; i <= maxHops; i++) {
        await loadCatInfo([cur]);
        const v = catCache.get(cur);
        if (v === true) return cur;             // real category
        if (typeof v === 'string') { cur = v; continue; } // soft redirect → follow
        return null;                            // missing/unusable
    }
    return null; // redirect chain too long — give up
}

// ---- geographic taxon category (§7.6) ---------------------------------------------

// Iconic taxon (scientific) → Commons place-category labels, most-preferred first. Plants
// use "Flora", animals "Animals" (with "Plants"/"Fauna" as fallbacks, often soft redirects).
const ICONIC_LABELS = {
    Plantae: ['Flora', 'Plants'],
    Animalia: ['Animals', 'Fauna'],
    Fungi: ['Fungi'],
};

/**
 * Most-specific existing Commons "<Taxon> <of|in> <Place>" category for a taxon + place
 * hierarchy, with soft redirects resolved to their real target. Returns null if none.
 */
export async function findGeoCategory(taxonId, hierarchy) {
    const anc = await getAncestry(taxonId);
    if (!anc) return null;

    // Candidate taxon labels, deepest first: scientific ancestry + iconic kingdom labels.
    const taxa = [];
    const push = (name, depth) => { if (name && depth != null) taxa.push({ name, depth }); };
    push(anc.self.name, RANK_DEPTH[anc.self.rank]);
    for (const a of anc.ancestors) push(a.name, RANK_DEPTH[a.rank]);
    const iconicDepth = (RANK_DEPTH[anc.iconicRank] ?? RANK_DEPTH.class) - 0.1;
    for (const label of ICONIC_LABELS[anc.iconicName] || (anc.iconic ? [anc.iconic] : []))
        push(label, iconicDepth);
    taxa.sort((a, b) => b.depth - a.depth);

    // Candidate places, deepest first; country also tried with a leading "the".
    const placeLevels = [];
    if (hierarchy.county) placeLevels.push([hierarchy.county]);
    if (hierarchy.state) placeLevels.push([hierarchy.state]);
    if (hierarchy.country) placeLevels.push([hierarchy.country, `the ${hierarchy.country}`]);
    if (placeLevels.length === 0) return null;

    const PREPS = ['of', 'in']; // "Flora of Hawaii" vs "Fabaceae in Hawaii"
    const title = (t, prep, pl) => `${t} ${prep} ${pl}`;

    // Warm the cache for every candidate in batches, then pick deepest place → deepest
    // taxon → preferred preposition, resolving soft redirects to the real category.
    const all = [];
    for (const variants of placeLevels) for (const pl of variants) for (const t of taxa) for (const prep of PREPS) all.push(title(t.name, prep, pl));
    await loadCatInfo(all);

    for (const variants of placeLevels)
        for (const pl of variants)
            for (const t of taxa)
                for (const prep of PREPS) {
                    const resolved = await resolveCategory(title(t.name, prep, pl));
                    if (resolved) return resolved;
                }
    return null;
}

// ---- author category (§7.5) -------------------------------------------------------

async function authorViaCommons(userId) {
    const url = `${COMMONS}?${new URLSearchParams({
        action: 'query', format: 'json', origin: '*', list: 'search',
        srnamespace: '14', srsearch: `insource:"Inaturalist user|${userId}"`, srlimit: '5',
    })}`;
    const data = await getJSON(url);
    return (data.query?.search || []).map((r) => r.title.replace(/^Category:/, ''));
}

async function authorViaWikidata(userId) {
    const q = `SELECT ?cat WHERE { ?item wdt:P12022 "${userId}". ?item wdt:P373 ?cat. }`;
    const data = await getJSON(`${WDQS}?${new URLSearchParams({ format: 'json', query: q })}`);
    return (data.results?.bindings || []).map((b) => b.cat.value);
}

/** Union of the Commons-template and Wikidata-P12022 author categories for an iNat user, cached. */
export async function findAuthorCategories(userId) {
    const key = String(userId);
    if (authorCache.has(key)) return authorCache.get(key);
    const found = new Set();
    for (const fn of [authorViaCommons, authorViaWikidata]) {
        try { (await fn(userId)).forEach((c) => found.add(c)); } catch { /* ignore source error */ }
    }
    return authorCache.set(key, [...found]);
}
