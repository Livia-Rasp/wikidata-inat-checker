import { simplify } from 'wikibase-sdk';

const BATCH_SIZE = 50;
const RANK_GENUS = 'Q34740';
const RANK_FAMILY = 'Q35409';
const HEADERS = { 'User-Agent': 'wikidata-inat-checker/1.0.0 (https://github.com/Livia-Rasp/wikidata-inat-checker)' };

function delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function qidFromUri(uri) {
    return uri.split('/').pop();
}

async function fetchEntities(qids) {
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
        rank: claims.P105?.[0],
        ncbi: claims.P685?.[0],
        eol: claims.P830?.[0],
        mycobank: claims.P962?.[0],
        fungorum: claims.P1391?.[0],
        hasWikispecies: !!entity.sitelinks?.specieswiki
    };
}

// Fetches entities in rounds, following P171 (parent taxon) links up the
// taxonomy tree until genus and family are found or depth limit is reached.
async function buildAncestorCache(itemQids) {
    const cache = {};
    let frontier = new Set(itemQids);

    for (let depth = 0; depth < 5 && frontier.size > 0; depth++) {
        if (depth > 0) await delay(1000);

        const toFetch = [...frontier].filter(q => !cache[q]);
        for (let i = 0; i < toFetch.length; i += BATCH_SIZE) {
            if (i > 0) await delay(1000);
            const batch = toFetch.slice(i, i + BATCH_SIZE);
            const data = await fetchEntities(batch);
            for (const qid of batch) {
                const entity = data.entities?.[qid];
                if (entity && !entity.missing) cache[qid] = parseEntity(entity);
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

function resolveGenusAndFamily(qid, cache) {
    let current = cache[qid]?.parentQid;
    let genus = null;
    let family = null;

    for (let i = 0; i < 10 && current && cache[current]; i++) {
        const data = cache[current];
        if (data.rank === RANK_GENUS && !genus) genus = data.taxonName;
        if (data.rank === RANK_FAMILY && !family) family = data.taxonName;
        if (genus && family) break;
        current = data.parentQid;
    }

    return { genus, family };
}

function buildWikitext(itemData, genus, familyName) {
    const { taxonName, ncbi, eol, mycobank, fungorum, rank, hasWikispecies } = itemData;
    if (!taxonName) return null;

    const parts = taxonName.split(' ');
    const resolvedGenus = genus || parts[0];
    const epithet = parts.slice(1).join(' ');

    const taxonavLines = [];
    // -aceae suffix indicates plant/fungal family with APG navigation template
    if (familyName?.endsWith('aceae')) {
        taxonavLines.push(`include=${familyName} (APG)|`);
    }
    taxonavLines.push(`Genus|${resolvedGenus}|`);
    taxonavLines.push(`Species|${taxonName}|`);
    taxonavLines.push(`authority=`);

    const lines = [
        '{{Wikidata Infobox}}',
        `{{Taxonavigation|\n${taxonavLines.join('\n')}}}`,
        '{{VN}}'
    ];
    if (hasWikispecies) lines.push('{{Wikispecies}}');
    if (ncbi) lines.push(`* {{NCBI|${ncbi}|''${taxonName}''}}`);
    if (eol) lines.push(`* {{EOL|${eol}|''${taxonName}''}}`);
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

    const cache = await buildAncestorCache(qids);

    const drafts = {};
    for (const qid of qids) {
        const itemData = cache[qid];
        if (!itemData) continue;
        const { genus, family } = resolveGenusAndFamily(qid, cache);
        const wikitext = buildWikitext(itemData, genus, family);
        if (wikitext) drafts[uriByQid[qid]] = wikitext;
    }

    return drafts;
}
