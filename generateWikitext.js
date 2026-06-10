// @ts-check
import { simplify } from 'wikibase-sdk';
import pLimit from 'p-limit';
import { HEADERS, qidFromUri } from './utils.js';

const ENTITY_BATCH   = 50;
const RANK_GENUS     = 'Q34740';
const RANK_FAMILY    = 'Q35409';
const RANK_ORDER     = 'Q36602';
const RANK_SUBCLASS  = 'Q5867051';
const RANK_CLASS     = 'Q37517';
const RANK_SUPERFAMILY = 'Q2136103';
const RANK_SUBFAMILY   = 'Q164280';
const RANK_TRIBE       = 'Q227936';
const RANK_SUBTRIBE    = 'Q3965313';
const RANK_LABELS   = {
    [RANK_CLASS]:       'Classis',
    [RANK_SUBCLASS]:    'Subclassis',
    [RANK_ORDER]:       'Ordo',
    [RANK_FAMILY]:      'Familia',
    [RANK_SUPERFAMILY]: 'Superfamilia',
    [RANK_SUBFAMILY]:   'Subfamilia',
    [RANK_TRIBE]:       'Tribus',
    [RANK_SUBTRIBE]:    'Subtribus',
};

// Commons category names for IUCN Red List statuses (verified against live categories).
// Least Concern (Q211005) omitted — no corresponding Commons maintenance category.
const IUCN_CATEGORIES = {
    'Q219127':  'IUCN Critically endangered species',
    'Q11394':   'IUCN Endangered species',
    'Q278113':  'IUCN Vulnerable species',
    'Q719675':  'IUCN Near Threatened species',
    'Q3245245': 'IUCN Data Deficient species',
    'Q237350':  'IUCN Extinct species',
    'Q239509':  'IUCN Extinct In The Wild species',
};

async function fetchNcbiAuthorities(items) {
    const result = new Map();
    for (const batch of chunk(items, 200)) {
        try {
            const ids = batch.map(i => i.ncbi).join(',');
            const url = `https://eutils.ncbi.nlm.nih.gov/entrez/eutils/efetch.fcgi?db=taxonomy&id=${ids}&retmode=xml`;
            const res = await fetch(url, { headers: HEADERS });
            const xml = await res.text();
            for (const block of xml.split('<Taxon>').slice(1)) {
                const idMatch   = block.match(/<TaxId>(\d+)<\/TaxId>/);
                const sciMatch  = block.match(/<ScientificName>(.+?)<\/ScientificName>/);
                const authMatch = block.match(/<ClassCDE>authority<\/ClassCDE>\s*<DispName>(.+?)<\/DispName>/);
                if (!idMatch) continue;
                const ncbiId = idMatch[1];
                if (!authMatch) { result.set(ncbiId, null); continue; }
                const dispName  = authMatch[1];
                const sciName   = sciMatch?.[1] ?? '';
                const wordCount = sciName ? sciName.split(' ').length : 0;
                const dispWords = dispName.trim().split(/\s+/);
                const raw = wordCount > 0 && wordCount < dispWords.length
                    ? dispWords.slice(wordCount).join(' ')
                    : dispName;
                result.set(ncbiId, raw.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>'));
            }
        } catch {
            for (const i of batch) result.set(i.ncbi, null);
        }
    }
    return result;
}

async function fetchTaxonavTemplates() {
    const api = 'https://commons.wikimedia.org/w/api.php';
    const names = new Set();

    async function fetchPages(catTitle) {
        let cont;
        do {
            const params = new URLSearchParams({
                action: 'query', list: 'categorymembers',
                cmtitle: catTitle, cmtype: 'page', cmlimit: '500',
                format: 'json', formatversion: '2',
                ...(cont ? { cmcontinue: cont } : {})
            });
            const res = await fetch(`${api}?${params}`, { headers: HEADERS });
            const data = await res.json();
            for (const m of data.query?.categorymembers ?? [])
                names.add(m.title.replace(/^Template:/, ''));
            cont = data.continue?.cmcontinue;
        } while (cont);
    }

    const params = new URLSearchParams({
        action: 'query', list: 'categorymembers',
        cmtitle: 'Category:Templates to include in Taxonavigation',
        cmtype: 'subcat', cmlimit: '500', format: 'json', formatversion: '2',
    });
    const res = await fetch(`${api}?${params}`, { headers: HEADERS });
    const data = await res.json();
    const subcats = (data.query?.categorymembers ?? []).map(m => m.title);

    await Promise.all([
        'Category:Templates to include in Taxonavigation',
        ...subcats,
    ].map(fetchPages));

    console.log(`Loaded ${names.size} Taxonavigation templates from Commons.`);
    return names;
}

/**
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
 * Batch-fetches Wikidata entities via wbgetentities (claims + specieswiki sitelink).
 * @param {string[]} qids
 * @returns {Promise<object>} Raw API response.
 */
export async function fetchEntities(qids) {
    const url = 'https://www.wikidata.org/w/api.php?' + new URLSearchParams({
        action: 'wbgetentities',
        ids: qids.join('|'),
        props: 'claims|sitelinks',
        sitefilter: 'specieswiki',
        format: 'json',
        formatversion: '2'
    });
    const res = await fetch(url, { headers: HEADERS });
    if (!res.ok) throw new Error(`Wikidata API HTTP ${res.status}`);
    return res.json();
}

function parseEntity(entity) {
    const claims = simplify.claims(entity.claims || {});
    return {
        taxonName: claims.P225?.[0],
        parentQid: claims.P171?.[0],
        rank:      claims.P105?.[0],
        ncbi:      claims.P685?.[0],
        eol:       claims.P830?.[0],
        mycobank:  claims.P962?.[0],
        fungorum:  claims.P1391?.[0],
        iucnStatus: claims.P141?.[0],
        hasWikispecies: !!entity.sitelinks?.specieswiki,
        hasVernacularName: (claims.P1843?.length ?? 0) > 0
    };
}

// Walks P171 links upward in parallel rounds until genus and family are cached
// for all items. Uses pLimit to avoid overwhelming the Wikidata API.
async function buildAncestorCache(itemQids) {
    const limit = pLimit(4);
    const cache = {};
    let frontier = new Set(itemQids);

    for (let depth = 0; depth < 7 && frontier.size > 0; depth++) {
        const toFetch = [...frontier].filter(q => !cache[q]);
        if (toFetch.length === 0) break;

        const batches = chunk(toFetch, ENTITY_BATCH);
        const results = await Promise.all(batches.map(b => limit(() => fetchEntities(b))));
        for (const data of results) {
            for (const [qid, entity] of Object.entries(data.entities || {})) {
                if (!entity.missing) cache[qid] = parseEntity(entity);
            }
        }

        const nextFrontier = new Set();
        for (const qid of frontier) {
            const parentQid = cache[qid]?.parentQid;
            if (parentQid && !cache[parentQid]) nextFrontier.add(parentQid);
        }
        frontier = nextFrontier;
    }

    return cache;
}

function resolveAncestors(qid, cache) {
    const chain = []; // genus-first (closest to species)
    let current = cache[qid]?.parentQid;
    for (let i = 0; i < 20 && current && cache[current]; i++) {
        const data = cache[current];
        if (data.taxonName) chain.push({ name: data.taxonName, rank: data.rank });
        current = data.parentQid;
    }
    return chain;
}

function buildWikitext(itemData, chain, templates) {
    const { taxonName, ncbi, eol, mycobank, fungorum, rank, hasWikispecies, authority } = itemData;
    if (!taxonName) return null;

    const parts = taxonName.split(' ');
    const genusAncestor = chain.find(a => a.rank === RANK_GENUS);
    const resolvedGenus = genusAncestor?.name || parts[0];
    const epithet = parts.slice(1).join(' ');

    const includeIdx = chain.findIndex(a => templates.has(a.name));
    const includeName = includeIdx >= 0 ? chain[includeIdx].name : null;
    const manualChain = includeIdx >= 0 ? chain.slice(0, includeIdx) : chain;
    const manualRanks = manualChain.filter(a => RANK_LABELS[a.rank]).reverse();

    const higherRankLabel = RANK_LABELS[rank] ?? (rank === RANK_GENUS ? 'Genus' : null);

    const taxonavLines = [];
    if (includeName) taxonavLines.push(`include=${includeName}|`);
    for (const { name, rank: r } of manualRanks) taxonavLines.push(`${RANK_LABELS[r]}|${name}|`);
    if (higherRankLabel) {
        taxonavLines.push(`${higherRankLabel}|${taxonName}|`);
    } else {
        taxonavLines.push(`Genus|${resolvedGenus}|`);
        taxonavLines.push(`Species|${taxonName}|`);
    }
    taxonavLines.push(`authority=${authority ?? ''}`);

    const lines = [
        '{{Wikidata Infobox}}',
        `{{Taxonavigation|\n${taxonavLines.join('\n')}}}`
    ];
    if (itemData.hasVernacularName) lines.push('{{VN}}');
    if (hasWikispecies) lines.push('{{Wikispecies}}');
    if (ncbi) lines.push(`* {{NCBI|${ncbi}|''${taxonName}''}}`);
    if (eol)  lines.push(`* {{EOL|${eol}|''${taxonName}''}}`);
    const fungorumTemplate = rank === RANK_GENUS ? 'Fungorum genus' : 'Fungorum species';
    if (mycobank) lines.push(`* {{MycoBank|${mycobank}|''${taxonName}''}}`);
    if (fungorum) lines.push(`* {{${fungorumTemplate}|${fungorum}|''${taxonName}''}}`);
    lines.push('');
    const parentCat = higherRankLabel ? (chain[0]?.name ?? taxonName) : resolvedGenus;
    const sortKey   = higherRankLabel ? taxonName : epithet;
    lines.push(`[[Category:${parentCat}|${sortKey}]]`);
    const iucnCat = IUCN_CATEGORIES[itemData.iucnStatus];
    if (iucnCat) lines.push(`[[Category:${iucnCat}]]`);

    return lines.join('\n');
}

/**
 * @param {Record<string, true>} available - wdUri → true for taxa with qualifying iNat photos
 * @returns {Promise<Record<string, string>>} wdUri → Commons category Wikitext draft
 */
export async function generateDraftWikitext(available) {
    const wdUris = Object.keys(available);
    if (wdUris.length === 0) {
        console.log('No available items, skipping draft generation.');
        return {};
    }
    console.log(`Generating Wikitext drafts for ${wdUris.length} items...`);

    const qids = wdUris.map(qidFromUri);
    const uriByQid = Object.fromEntries(wdUris.map(uri => [qidFromUri(uri), uri]));

    const [cache, templates] = await Promise.all([
        buildAncestorCache(qids),
        fetchTaxonavTemplates(),
    ]);

    const ncbiItems = qids
        .filter(qid => cache[qid]?.ncbi)
        .map(qid => ({ ncbi: cache[qid].ncbi, taxonName: cache[qid].taxonName }));
    const authorities = ncbiItems.length > 0 ? await fetchNcbiAuthorities(ncbiItems) : new Map();

    const drafts = {};
    for (const qid of qids) {
        const itemData = cache[qid];
        if (!itemData) continue;
        const chain = resolveAncestors(qid, cache);
        const authority = authorities.get(itemData.ncbi) ?? '';
        const wikitext = buildWikitext({ ...itemData, authority }, chain, templates);
        if (wikitext) drafts[uriByQid[qid]] = wikitext;
    }

    return drafts;
}
