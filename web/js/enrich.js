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
const geocodeCache = new Cache('geocode');   // "lat,lon" → { places, iso, county } | null
const placeCatCache = new Cache('placewd');  // "ISO|county" → { state?, county? } exact Commons cats

// iNat admin levels: 0 = country, 10 = state/region, 20 = county/district. We also use 30 for
// the municipality/town level that reverse geocoding can supply when iNat lacks a community place.
const ADMIN = { COUNTRY: 0, STATE: 10, COUNTY: 20, MUNICIPALITY: 30 };

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

/**
 * Build place names from an observation's place_ids (must be resolved). Returns the named
 * { county, state, country } levels (for the description text) plus `places`: every resolved
 * place with a numeric admin_level, ordered deepest-first (higher admin_level = more specific),
 * one entry per level. `places` drives the geographic-category search, so it captures the
 * finest level iNat provides (city/municipality where present), not just county/state/country.
 */
export function placeHierarchy(placeIds) {
    const byLevel = new Map(); // admin_level → name (first seen at that level)
    for (const id of placeIds || []) {
        const p = placeCache.get(String(id));
        if (p && typeof p.admin_level === 'number' && !byLevel.has(p.admin_level)) byLevel.set(p.admin_level, p.name);
    }
    const places = [...byLevel.entries()]
        .sort(([a], [b]) => b - a) // deepest (highest admin_level) first
        .map(([level, name]) => ({ name, level }));
    return {
        county: byLevel.get(ADMIN.COUNTY) || null,
        state: byLevel.get(ADMIN.STATE) || null,
        country: byLevel.get(ADMIN.COUNTRY) || null,
        places,
    };
}

/** "County, State, Country" from present levels, or "" if none. */
export function locationString(h) {
    return [h.county, h.state, h.country].filter(Boolean).join(', ');
}

// ---- reverse geocoding (OpenStreetMap Nominatim) -----------------------------------
//
// iNat's place_ids already reverse-geocode the observation's GPS, but their sub-county
// coverage is patchy. Nominatim fills the gap — most usefully the municipality/town level —
// and supplies any missing county/state/country. Results are cached per ~110 m coordinate
// cell and calls are serialised ≥1.1 s apart to honour Nominatim's ~1 req/sec usage policy.
// (Browsers can't set User-Agent — the page Referer satisfies the policy's identification
// requirement instead.) Any failure returns null and we fall back to the iNat hierarchy.
const NOMINATIM = 'https://nominatim.openstreetmap.org/reverse';

// Nominatim address fields (most-to-least specific synonyms) → our admin level.
const NOMINATIM_LEVELS = [
    [['city', 'town', 'village', 'municipality', 'hamlet'], ADMIN.MUNICIPALITY],
    [['county'], ADMIN.COUNTY],
    [['state', 'province', 'region'], ADMIN.STATE],
    [['country'], ADMIN.COUNTRY],
];

function parseNominatim(data) {
    const addr = data?.address;
    if (!addr) return null;
    const places = [];
    for (const [fields, level] of NOMINATIM_LEVELS) {
        const name = fields.map((f) => addr[f]).find(Boolean);
        if (name) places.push({ name, level });
    }
    if (!places.length) return null;
    // The province's ISO 3166-2 code (e.g. "EC-U") and the county name anchor an exact
    // Commons-category lookup via Wikidata (resolvePlaceCats), which handles the region-specific
    // suffixes/diacritics ("Sucumbíos Province", "Lago Agrio Canton") our heuristics can't guess.
    const isoKey = Object.keys(addr).find((k) => /^ISO3166-2/i.test(k));
    return {
        places: places.sort((a, b) => b.level - a.level),
        iso: isoKey ? addr[isoKey] : null,
        county: places.find((p) => p.level === ADMIN.COUNTY)?.name || null,
    };
}

let geocodeQueue = Promise.resolve(); // serialises Nominatim calls
let lastGeocodeAt = 0;

/** Reverse-geocode a point to `{ places, iso, county }` (places deepest-first) or null, cached + throttled. */
export function reverseGeocode(lat, lon) {
    const key = `${lat.toFixed(3)},${lon.toFixed(3)}`;
    if (geocodeCache.has(key)) return Promise.resolve(geocodeCache.get(key));
    const run = geocodeQueue.then(async () => {
        if (geocodeCache.has(key)) return geocodeCache.get(key);
        const wait = 1100 - (Date.now() - lastGeocodeAt);
        if (wait > 0) await new Promise((r) => setTimeout(r, wait));
        lastGeocodeAt = Date.now();
        try {
            const url = `${NOMINATIM}?${new URLSearchParams({
                format: 'jsonv2', lat, lon, zoom: '14', addressdetails: '1',
            })}`;
            return geocodeCache.set(key, parseNominatim(await getJSON(url)));
        } catch { return geocodeCache.set(key, null); }
    });
    geocodeQueue = run.catch(() => {}); // keep the chain alive after a rejection
    return run;
}

/**
 * Merge reverse-geocoded places into a place hierarchy, in place. Only levels iNat didn't
 * already provide are added (iNat names are bare and proven to match Commons, so they win),
 * and the named county/state/country fields are backfilled when missing.
 */
export function mergeGeocodedPlaces(hierarchy, geoPlaces) {
    if (!geoPlaces?.length) return hierarchy;
    const byLevel = new Map(hierarchy.places.map((p) => [p.level, p]));
    for (const gp of geoPlaces) {
        const existing = byLevel.get(gp.level);
        if (existing) { if (gp.commonsCat && !existing.commonsCat) existing.commonsCat = gp.commonsCat; }
        else { hierarchy.places.push(gp); byLevel.set(gp.level, gp); }
        if (gp.level === ADMIN.COUNTRY && !hierarchy.country) hierarchy.country = gp.name;
        else if (gp.level === ADMIN.STATE && !hierarchy.state) hierarchy.state = gp.name;
        else if (gp.level === ADMIN.COUNTY && !hierarchy.county) hierarchy.county = gp.name;
    }
    hierarchy.places.sort((a, b) => b.level - a.level);
    return hierarchy;
}

// SPARQL string literal (double-quoted), escaping backslashes/quotes/newlines.
const sparqlStr = (s) => `"${String(s).replace(/[\\"]/g, '\\$&').replace(/[\r\n]/g, ' ')}"`;

/**
 * Exact Commons categories for the province (by ISO 3166-2 code) and its named county, via
 * Wikidata — handles the region-specific naming our heuristics can't (`Sucumbíos Province`,
 * `Lago Agrio Canton`). Returns `{ state?, county? }` (category names), cached per ISO+county.
 */
async function resolvePlaceCats(iso, county) {
    if (!iso) return {};
    const key = `${iso}|${county || ''}`;
    if (placeCatCache.has(key)) return placeCatCache.get(key);
    const countyBranch = county ? `UNION {
        BIND("county" AS ?level) ?st wdt:P300 ${sparqlStr(iso)}. ?area wdt:P131 ?st.
        { ?area rdfs:label ?l } UNION { ?area skos:altLabel ?l }
        FILTER(LANG(?l) IN ("en","es","fr","de","pt","it","nl","mul")) FILTER(LCASE(STR(?l)) = LCASE(${sparqlStr(county)}))
    }` : '';
    const query = `SELECT DISTINCT ?level ?p373 ?sitelink WHERE {
        { BIND("state" AS ?level) ?area wdt:P300 ${sparqlStr(iso)}. } ${countyBranch}
        OPTIONAL { ?area wdt:P373 ?p373 }
        OPTIONAL { ?sitelink schema:about ?area; schema:isPartOf <https://commons.wikimedia.org/> }
    }`;
    try {
        const data = await getJSON(`${WDQS}?${new URLSearchParams({ format: 'json', query })}`);
        const out = {};
        for (const b of data.results?.bindings || []) {
            const fromSitelink = b.sitelink && /\/wiki\/Category:/.test(b.sitelink.value)
                ? decodeURIComponent(b.sitelink.value.split('/wiki/Category:')[1]).replace(/_/g, ' ') : null;
            const cat = b.p373?.value || fromSitelink;
            if (cat && !out[b.level.value]) out[b.level.value] = cat;
        }
        return placeCatCache.set(key, out);
    } catch { return {}; /* don't cache a transient failure */ }
}

/**
 * Reverse-geocode an observation's point into place levels — but only as precisely as the
 * coordinates justify. Obscured/private records expose a randomized point (threatened taxa are
 * obscured by ~km), so they're skipped entirely (also keeping threatened localities coarse);
 * a coarse `public_positional_accuracy` skips the geocode (>20 km) or at least drops the
 * municipality level (>2 km). Each returned place carries an exact Commons `commonsCat` where
 * Wikidata could resolve it. Returns `[]` when geocoding isn't safe.
 */
export async function geocodePlaces(obs) {
    const coords = obs?.geojson?.coordinates;
    if (!coords) return [];
    const acc = obs.public_positional_accuracy;
    const obscured = ['obscured', 'private'].includes(obs.geoprivacy)
        || ['obscured', 'private'].includes(obs.taxon_geoprivacy);
    if (obscured || (typeof acc === 'number' && acc > 20000)) return [];
    const geo = await reverseGeocode(coords[1], coords[0]);
    if (!geo) return [];
    const places = (typeof acc === 'number' && acc > 2000)
        ? geo.places.filter((p) => p.level < ADMIN.MUNICIPALITY)
        : geo.places;
    const cats = await resolvePlaceCats(geo.iso, geo.county);
    return places.map((p) => ({
        ...p,
        commonsCat: p.level === ADMIN.STATE ? cats.state : p.level === ADMIN.COUNTY ? cats.county : undefined,
    }));
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
// Commons categories are categorised inconsistently by hand, with several traps for an
// automated "<Taxon> <prep> <Place>" guesser:
//  - Soft redirects: many cats exist only as {{Category redirect|<target>}} (e.g.
//    "Plants of Hawaii" → "Flora of Hawaii"). The page exists, so a plain existence check
//    treats it as valid and files images into a deprecated redirect. We must detect the
//    template and follow it to the real target.
//  - Disambiguation pages: a bare place name ("Victoria", "Washington") often lands on a
//    {{Disambig}} page — a real page that is never a valid image category. Reject it.
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

// Disambiguation category pages (e.g. "Category:Victoria", "Category:Washington") carry a
// {{Disambig}}/{{Disambiguation}} template. They exist as pages but are never a valid image
// category, so a bare place name that lands on one must be rejected like a missing page.
const DISAMBIG_TEMPLATES = new Set([
    'disambig', 'disambiguation', 'disamb', 'disam', 'disambigcat', 'disambiguationcategory',
    'categorydisambig', 'categorydisambiguation', 'catdisambig', 'catdisambiguation', 'catdisamb',
]);

/** Whether `wikitext` marks the page as a disambiguation page. */
function isDisambiguation(wikitext) {
    const re = /\{\{\s*([^|}\n]+?)\s*(?:\||\}\})/g;
    let m;
    while ((m = re.exec(wikitext))) {
        if (DISAMBIG_TEMPLATES.has(m[1].toLowerCase().replace(/[ _-]/g, ''))) return true;
    }
    return false;
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
                // redirect with target → store target; redirect with no parseable target, or a
                // disambiguation page → unusable (false); otherwise a real category (true).
                if (target !== null) { catCache.set(requested, target || false); continue; }
                catCache.set(requested, isDisambiguation(text) ? false : true);
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

// iNat place names carry diacritics (`Québec`, `Núrnberg`); Commons titles often don't
// (`Flora of Quebec`). Strip combining marks so the accented form can fall back to the plain one.
const deaccent = (s) => s.normalize('NFD').replace(/[\u0300-\u036f]/g, '');

/** resolveCategory, but if the exact title misses, retry its deaccented form. */
async function resolveAnyCase(name) {
    const hit = await resolveCategory(name);
    if (hit) return hit;
    const d = deaccent(name);
    return d !== name ? resolveCategory(d) : null;
}

// ---- geographic taxon category (§7.6) ---------------------------------------------

// Iconic taxon (scientific) → Commons place-category labels, most-preferred first. Plants
// use "Flora", animals "Animals" (with "Plants"/"Fauna" as fallbacks, often soft redirects).
const ICONIC_LABELS = {
    Plantae: ['Flora', 'Plants'],
    Animalia: ['Animals', 'Fauna'],
    Fungi: ['Fungi'],
};

// "Nature of <place>" collects all living organisms of a place — broader than any single
// kingdom label (Flora/Fauna/Fungi), narrower than the plain place category. So on the taxon
// axis it sits one tier *below* kingdom: more general than a kingdom label, more specific than
// a plain place (-Infinity). Preferred over the plain place for these organism images.
const NATURE_DEPTH = RANK_DEPTH.kingdom - 1;

// A resolved category, tagged with its position on the two axes used for redundancy checks:
// taxonDepth (higher = more taxon-specific; -Infinity for a plain place category) and
// placeLevel (the iNat admin_level; higher = more place-specific).
// `a` is an ancestor of `b` — and thus redundant alongside it — when it is more general (or
// equal) on BOTH axes. This holds structurally because every place comes from one nested
// hierarchy (city ⊂ county ⊂ state ⊂ country), so "<Taxon> of <FinePlace>" is a subcategory
// of "<CoarserTaxon> of <CoarserPlace>" exactly when both axes are ≤.
function isAncestor(a, b) {
    return a.name !== b.name && a.taxonDepth <= b.taxonDepth && a.placeLevel <= b.placeLevel;
}

// First candidate `{ title, taxonDepth, placeLevel }` whose title resolves to a real category
// (soft redirects + diacritics handled), returned with its resolved name; null if none resolve.
async function firstResolved(candidates) {
    for (const c of candidates) {
        const name = await resolveAnyCase(c.title);
        if (name) return { name, taxonDepth: c.taxonDepth, placeLevel: c.placeLevel };
    }
    return null;
}

// Combine the two anchors, dropping either when it is an ancestor (nested parent) of the other.
function mergeAnchors(a, b) {
    if (!a || !b) return [a?.name, b?.name].filter(Boolean);
    if (a.name === b.name) return [a.name];
    if (isAncestor(a, b)) return [b.name];
    if (isAncestor(b, a)) return [a.name];
    return [a.name, b.name];
}

/**
 * Best-effort Commons geographic categories for a photo, along two independent axes, with
 * redundant (nested) categories removed:
 *  - taxon anchor — the most TAXON-specific "<Taxon> <of|in> <Place>" (place falls through),
 *  - place anchor — the most PLACE-specific category at the finest admin level available,
 *    preferring "Flora/Fauna/Fungi of <place>", then "Nature of <place>" (all organisms),
 *    then the plain "<place>" category.
 * Returns 0–2 category names (soft redirects resolved). When neither anchor is a subcategory
 * of the other they are both kept; when one contains the other, only the more specific stays.
 */
export async function findGeoCategories(taxonId, hierarchy) {
    const anc = await getAncestry(taxonId);
    if (!anc) return [];

    // Candidate taxon labels, deepest first: scientific ancestry + iconic kingdom labels.
    const taxa = [];
    const push = (name, depth) => { if (name && depth != null) taxa.push({ name, depth }); };
    push(anc.self.name, RANK_DEPTH[anc.self.rank]);
    for (const a of anc.ancestors) push(a.name, RANK_DEPTH[a.rank]);
    const iconicDepth = (RANK_DEPTH[anc.iconicRank] ?? RANK_DEPTH.class) - 0.1;
    const kingdomLabels = (ICONIC_LABELS[anc.iconicName] || (anc.iconic ? [anc.iconic] : []))
        .map((name) => ({ name, depth: iconicDepth }));
    for (const label of kingdomLabels) push(label.name, label.depth);
    taxa.sort((a, b) => b.depth - a.depth);

    // Candidate places, deepest first. `variants` is for the "<Taxon> <of|in> <place>" form
    // (country also tried with a leading "the"). `plainTitles` is for the bare place-category
    // fallback and follows Commons' *disambiguated* naming, not iNat's bare name: a county is
    // "<Name> County, <State>", a town "<Name>, <State>". The bare iNat name ("Perry",
    // "Medina") would hit an unrelated or disambiguation page, so sub-state levels are only
    // tried in their qualified form (and otherwise fall up to the next coarser place).
    const region = hierarchy.state || hierarchy.country || null;
    const placeLevels = (hierarchy.places || []).filter((p) => p.level >= ADMIN.COUNTRY).map((p) => {
        const variants = p.level === ADMIN.COUNTRY ? [p.name, `the ${p.name}`] : [p.name];
        let plainTitles;
        if (p.commonsCat) plainTitles = [p.commonsCat];                            // exact, via Wikidata (ISO/name)
        else if (p.level <= ADMIN.STATE) plainTitles = [p.name];                   // "Texas", "United States"
        else if (p.level === ADMIN.COUNTY) {
            // iNat gives a bare "Perry"; Nominatim already includes the suffix ("Perry County").
            const base = /\b(County|Parish|Borough|Census Area|Municipality)$/i.test(p.name) ? p.name : `${p.name} County`;
            plainTitles = region ? [`${base}, ${region}`] : [];
        } else plainTitles = region ? [`${p.name}, ${region}`] : [];               // town/municipality
        return { level: p.level, variants, plainTitles };
    });
    if (placeLevels.length === 0) return [];

    const PREPS = ['of', 'in']; // "Flora of Hawaii" vs "Fabaceae in Hawaii"
    // "<taxon> <of|in> <place>" titles for one taxon label at one place level.
    const taxonPlaceTitles = (name, place) => place.variants.flatMap((pl) => PREPS.map((prep) => `${name} ${prep} ${pl}`));
    // "Nature of <place>" titles. Built from both the taxon-style variants ("the <country>")
    // and the disambiguated plain titles ("<county>, <state>") so the right Commons name is hit
    // at every level (e.g. "Nature of the United States", "Nature of Pasco Department").
    const natureTitles = (place) => [...new Set([...place.variants, ...place.plainTitles])].map((b) => `Nature of ${b}`);

    // Candidates per axis, ordered most-specific first; firstResolved picks the first that
    // exists. Taxon anchor: every taxon, deepest first (place falls through). Place anchor: each
    // place, deepest first, as "Flora/Fauna/Fungi of <place>" then the plain place category.
    const taxonCands = taxa.flatMap((t) =>
        placeLevels.flatMap((place) =>
            taxonPlaceTitles(t.name, place).map((title) => ({ title, taxonDepth: t.depth, placeLevel: place.level }))));
    const placeCands = placeLevels.flatMap((place) => [
        ...kingdomLabels.flatMap((label) =>
            taxonPlaceTitles(label.name, place).map((title) => ({ title, taxonDepth: label.depth, placeLevel: place.level }))),
        ...natureTitles(place).map((title) => ({ title, taxonDepth: NATURE_DEPTH, placeLevel: place.level })),
        ...place.plainTitles.map((title) => ({ title, taxonDepth: -Infinity, placeLevel: place.level })),
    ]);

    // One batched existence pass over both candidate sets (accented + deaccented forms).
    const titles = [...taxonCands, ...placeCands].flatMap((c) => [c.title, deaccent(c.title)]);
    await loadCatInfo([...new Set(titles)]);

    const [taxonAnchor, placeAnchor] = await Promise.all([firstResolved(taxonCands), firstResolved(placeCands)]);
    return mergeAnchors(taxonAnchor, placeAnchor);
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
