// @ts-check
import { simplify } from 'wikibase-sdk';
import pLimit from 'p-limit';
import { HEADERS, qidFromUri, chunk, IUCN_QID_TO_CODE } from './utils.js';

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
// Used as fallback when P627 (IUCN taxon ID) is absent; otherwise {{IUCN}} auto-categorizes.
const IUCN_CATEGORIES = {
    'Q219127':  'IUCN Critically endangered species',
    'Q96377276': 'IUCN Endangered species',
    'Q278113':  'IUCN Vulnerable species',
    'Q719675':  'IUCN Near Threatened species',
    'Q3245245': 'IUCN Data Deficient species',
    'Q237350':  'IUCN Extinct species',
    'Q239509':  'IUCN Extinct In The Wild species',
};

// P141 QIDs → 2-letter status codes expected by {{IUCN}} param 1: IUCN_QID_TO_CODE (utils.js).

/**
 * Fetches the author citation (e.g. "Linnaeus, 1758") for each item's NCBI taxon ID
 * via NCBI E-utilities, parsing the XML by hand (no XML dep). NCBI's authority
 * "DispName" is the full scientific name followed by the citation, so we strip the
 * leading scientific-name words to leave just the author part.
 * @param {{ncbi: string, taxonName?: string}[]} items
 * @returns {Promise<Map<string, string|null>>} NCBI taxon ID → authority (null if none/error)
 */
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
                // Drop the leading scientific-name words from the DispName, keeping the citation.
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

    // Build base-name → full-name lookup.
    // Suffixed variants (APG, IOC, Smith…) take precedence over plain names.
    // Skip internal "(include)" templates (used by Coleoptera/Lepidoptera wrappers internally)
    // and any sub-page entries like "Foo/sandbox".
    const lookup = new Map();
    for (const name of names) {
        if (name.includes('/')) continue;
        if (name.endsWith(' (include)')) continue;
        const parenIdx = name.indexOf(' (');
        const baseName = parenIdx >= 0 ? name.slice(0, parenIdx) : name;
        if (!lookup.has(baseName) || parenIdx >= 0) lookup.set(baseName, name);
    }
    console.log(`Loaded ${lookup.size} Taxonavigation templates from Commons.`);
    return lookup;
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
        iucnId:     claims.P627?.[0],
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

    for (let depth = 0; depth < 20 && frontier.size > 0; depth++) {
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

// Builds the {{Coleoptera}} or {{Lepidoptera}} block (same named-param convention).
// useSubtribus: Coleoptera supports |subtribus=, Lepidoptera does not.
function buildOrderBlock(templateName, useSubtribus, itemData, chain, higherRankLabel, resolvedGenus, epithet) {
    const { taxonName, rank, authority } = itemData;

    const familiaName = rank === RANK_FAMILY ? taxonName
        : chain.find(a => a.rank === RANK_FAMILY)?.name;
    if (!familiaName) return null; // familia= is required by the template

    const subfamiliaName = rank === RANK_SUBFAMILY ? taxonName
        : chain.find(a => a.rank === RANK_SUBFAMILY)?.name;
    const tribusName = rank === RANK_TRIBE ? taxonName
        : chain.find(a => a.rank === RANK_TRIBE)?.name;
    const subtribusName = useSubtribus && (rank === RANK_SUBTRIBE ? taxonName
        : chain.find(a => a.rank === RANK_SUBTRIBE)?.name);

    const params = [`|familia=${familiaName}`];
    if (subfamiliaName) params.push(`|subfamilia=${subfamiliaName}`);
    if (tribusName) params.push(`|tribus=${tribusName}`);
    if (subtribusName) params.push(`|subtribus=${subtribusName}`);

    if (rank === RANK_GENUS) {
        params.push(`|genus=${taxonName}`);
    } else if (!higherRankLabel) {
        // Species level: genus= + species= epithet only
        params.push(`|genus=${resolvedGenus}`);
        params.push(`|species=${epithet}`);
    }
    // Family/subfamily/tribe/subtribe ranks: no genus/species params

    params.push(`|auth=${authority ?? ''}`);
    return `{{${templateName}\n${params.join('\n')}}}`;
}

function buildWikitext(itemData, chain, templates) {
    const { taxonName, ncbi, eol, mycobank, fungorum, rank, hasWikispecies, authority, iucnId } = itemData;
    if (!taxonName) return null;

    const parts = taxonName.split(' ');
    const genusAncestor = chain.find(a => a.rank === RANK_GENUS);
    const resolvedGenus = genusAncestor?.name || parts[0];
    const epithet = parts.slice(1).join(' ');
    const higherRankLabel = RANK_LABELS[rank] ?? (rank === RANK_GENUS ? 'Genus' : null);

    const lines = ['{{Wikidata Infobox}}'];

    const isInColeoptera  = chain.some(a => a.rank === RANK_ORDER && a.name === 'Coleoptera');
    const isInLepidoptera = chain.some(a => a.rank === RANK_ORDER && a.name === 'Lepidoptera');
    if (isInColeoptera) {
        const block = buildOrderBlock('Coleoptera', true, itemData, chain, higherRankLabel, resolvedGenus, epithet);
        if (!block) return null;
        lines.push(block);
    } else if (isInLepidoptera) {
        const block = buildOrderBlock('Lepidoptera', false, itemData, chain, higherRankLabel, resolvedGenus, epithet);
        if (!block) return null;
        lines.push(block);
    } else {
        const includeIdx = chain.findIndex(a => templates.has(a.name));
        const includeName = includeIdx >= 0 ? templates.get(chain[includeIdx].name) : null;
        const manualChain = includeIdx >= 0 ? chain.slice(0, includeIdx) : chain;
        const manualRanks = manualChain.filter(a => RANK_LABELS[a.rank]).reverse();

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
        lines.push(`{{Taxonavigation|\n${taxonavLines.join('\n')}}}`);
    }

    if (itemData.hasVernacularName) lines.push('{{VN}}');
    if (hasWikispecies) lines.push('{{Wikispecies}}');
    if (ncbi) lines.push(`* {{NCBI|${ncbi}|''${taxonName}''}}`);
    const iucnCode = IUCN_QID_TO_CODE[itemData.iucnStatus];
    if (iucnId && iucnCode) lines.push(`* {{IUCN|${iucnCode}|${iucnId}|${taxonName}|${authority ?? ''}}}`);
    if (eol)  lines.push(`* {{EOL|${eol}|''${taxonName}''}}`);
    const fungorumTemplate = rank === RANK_GENUS ? 'Fungorum genus' : 'Fungorum species';
    if (mycobank) lines.push(`* {{MycoBank|${mycobank}|''${taxonName}''}}`);
    if (fungorum) lines.push(`* {{${fungorumTemplate}|${fungorum}|''${taxonName}''}}`);
    lines.push('');
    const parentCat = higherRankLabel ? (chain[0]?.name ?? taxonName) : resolvedGenus;
    const sortKey   = higherRankLabel ? taxonName : epithet;
    lines.push(`[[Category:${parentCat}|${sortKey}]]`);
    if (!iucnId) {
        const iucnCat = IUCN_CATEGORIES[itemData.iucnStatus];
        if (iucnCat) lines.push(`[[Category:${iucnCat}]]`);
    }

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
