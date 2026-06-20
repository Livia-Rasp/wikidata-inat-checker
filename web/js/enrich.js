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
        };
        return ancestryCache.set(key, result);
    } catch { return null; }
}

// ---- Commons category existence (§7.6) ---------------------------------------------

/** Check existence of category titles (names without the "Category:" prefix), cached + batched. */
export async function categoryExists(names) {
    const todo = [...new Set(names)].filter((n) => !catCache.has(n));
    for (const batch of chunk(todo, 45)) {
        try {
            const titles = batch.map((n) => 'Category:' + n).join('|');
            const url = `${COMMONS}?${new URLSearchParams({ action: 'query', format: 'json', origin: '*', prop: 'info', titles })}`;
            const data = await getJSON(url);
            const norm = data.query?.normalized || [];
            const back = new Map(norm.map((x) => [x.to, x.from])); // normalized → requested
            const got = new Set();
            for (const p of Object.values(data.query?.pages || {})) {
                const requested = (back.get(p.title) || p.title).replace(/^Category:/, '');
                got.add(requested);
                catCache.set(requested, !('missing' in p));
            }
            for (const n of batch) if (!got.has(n)) catCache.set(n, false);
        } catch { /* retry next time */ }
    }
    const out = {};
    for (const n of new Set(names)) out[n] = catCache.get(n) === true;
    return out;
}

// ---- geographic taxon category (§7.6) ---------------------------------------------

/** Most-specific existing "<Taxon> of <Place>" category for a taxon + place hierarchy, or null. */
export async function findGeoCategory(taxonId, hierarchy) {
    const anc = await getAncestry(taxonId);
    if (!anc) return null;

    // Candidate taxa, deepest first.
    const taxa = [];
    const push = (name, depth) => { if (name && depth != null) taxa.push({ name, depth }); };
    push(anc.self.name, RANK_DEPTH[anc.self.rank]);
    for (const a of anc.ancestors) push(a.name, RANK_DEPTH[a.rank]);
    if (anc.iconic) push(anc.iconic, (RANK_DEPTH[anc.iconicRank] ?? RANK_DEPTH.class) - 0.1);
    taxa.sort((a, b) => b.depth - a.depth);

    // Candidate places, deepest first; country also tried with a leading "the".
    const placeLevels = [];
    if (hierarchy.county) placeLevels.push([hierarchy.county]);
    if (hierarchy.state) placeLevels.push([hierarchy.state]);
    if (hierarchy.country) placeLevels.push([hierarchy.country, `the ${hierarchy.country}`]);
    if (placeLevels.length === 0) return null;

    // Existence-check every candidate, then pick deepest place → deepest taxon.
    const all = [];
    for (const variants of placeLevels) for (const pl of variants) for (const t of taxa) all.push(`${t.name} of ${pl}`);
    const exists = await categoryExists(all);

    for (const variants of placeLevels)
        for (const pl of variants)
            for (const t of taxa) {
                const title = `${t.name} of ${pl}`;
                if (exists[title]) return title;
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
