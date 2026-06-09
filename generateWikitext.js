import { simplify } from 'wikibase-sdk';
import pLimit from 'p-limit';

const ENTITY_BATCH  = 50;
const RANK_GENUS    = 'Q34740';
const RANK_FAMILY   = 'Q35409';
const RANK_ORDER    = 'Q36602';
const RANK_SUBCLASS = 'Q5867051';
const RANK_CLASS    = 'Q37517';
const RANK_LABELS   = {
    [RANK_CLASS]:    'Classis',
    [RANK_SUBCLASS]: 'Subclassis',
    [RANK_ORDER]:    'Ordo',
    [RANK_FAMILY]:   'Familia',
};
const HEADERS = { 'User-Agent': 'wikidata-inat-checker/1.0.0 (https://github.com/Livia-Rasp/wikidata-inat-checker)' };

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

export function chunk(arr, n) {
    const out = [];
    for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
    return out;
}

function qidFromUri(uri) {
    return uri.split('/').pop();
}

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
    const { taxonName, ncbi, eol, mycobank, fungorum, rank, hasWikispecies } = itemData;
    if (!taxonName) return null;

    const parts = taxonName.split(' ');
    const genusAncestor = chain.find(a => a.rank === RANK_GENUS);
    const resolvedGenus = genusAncestor?.name || parts[0];
    const epithet = parts.slice(1).join(' ');

    const includeIdx = chain.findIndex(a => templates.has(a.name));
    const includeName = includeIdx >= 0 ? chain[includeIdx].name : null;
    const manualChain = includeIdx >= 0 ? chain.slice(0, includeIdx) : chain;
    const manualRanks = manualChain.filter(a => RANK_LABELS[a.rank]).reverse();

    const taxonavLines = [];
    if (includeName) taxonavLines.push(`include=${includeName}|`);
    for (const { name, rank: r } of manualRanks) taxonavLines.push(`${RANK_LABELS[r]}|${name}|`);
    taxonavLines.push(`Genus|${resolvedGenus}|`);
    taxonavLines.push(`Species|${taxonName}|`);
    taxonavLines.push(`authority=`);

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
    lines.push(`[[Category:${resolvedGenus}|${epithet}]]`);

    return lines.join('\n');
}

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

    const drafts = {};
    for (const qid of qids) {
        const itemData = cache[qid];
        if (!itemData) continue;
        const chain = resolveAncestors(qid, cache);
        const wikitext = buildWikitext(itemData, chain, templates);
        if (wikitext) drafts[uriByQid[qid]] = wikitext;
    }

    return drafts;
}
