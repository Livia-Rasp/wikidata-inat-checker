import { simplify } from 'wikibase-sdk';
import { JsonDB, Config } from 'node-json-db';

const db = new JsonDB(new Config("inattWDPhotoCache", false, true, ';'));

const BATCH_SIZE = 50;
const RANK_GENUS = 'Q34740';
const RANK_FAMILY = 'Q35409';
const HEADERS = { 'User-Agent': 'wikidata-inat-checker/0.8.0 (https://github.com/Livia-Rasp/wikidata-inat-checker)' };

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
        hasWikispecies: !!entity.sitelinks?.specieswiki
    };
}

// Fetches entities in rounds, following P171 (parent taxon) links up the
// taxonomy tree until genus and family are found or depth limit is reached.
async function buildAncestorCache(itemQids) {
    const cache = {};
    let frontier = new Set(itemQids);

    for (let depth = 0; depth < 5 && frontier.size > 0; depth++) {
        if (depth > 0) await new Promise(r => setTimeout(r, 1000));

        const toFetch = [...frontier].filter(q => !cache[q]);
        for (let i = 0; i < toFetch.length; i += BATCH_SIZE) {
            if (i > 0) await new Promise(r => setTimeout(r, 1000));
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
    const { taxonName, ncbi, eol, hasWikispecies } = itemData;
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
    taxonavLines.push(`authority=<!-- authority -->`);

    const lines = [
        '{{Wikidata Infobox}}',
        `{{Taxonavigation|\n${taxonavLines.join('\n')}}}`,
        '{{VN}}'
    ];
    if (hasWikispecies) lines.push('{{Wikispecies}}');
    if (ncbi) lines.push(`* {{NCBI|${ncbi}|''${taxonName}''}}`);
    if (eol) lines.push(`* {{EOL|${eol}|''${taxonName}''}}`);
    lines.push('');
    lines.push(`[[Category:${resolvedGenus}|${epithet}]]`);

    return lines.join('\n');
}

export async function generateDraftWikitext() {
    await db.reload();

    let available;
    try {
        available = await db.getData(';available');
    } catch {
        console.log('No available items found, skipping draft generation.');
        return;
    }

    const wdUris = Object.keys(available);
    const todo = [];
    for (const uri of wdUris) {
        if (!(await db.exists(';drafts;' + uri))) todo.push(uri);
    }

    if (todo.length === 0) {
        console.log('All Wikitext drafts already up to date.');
        return;
    }
    console.log(`Generating Wikitext drafts for ${todo.length} items...`);

    const qids = todo.map(qidFromUri);
    const uriByQid = Object.fromEntries(todo.map(uri => [qidFromUri(uri), uri]));

    const cache = await buildAncestorCache(qids);

    for (const qid of qids) {
        const itemData = cache[qid];
        if (!itemData) continue;
        const { genus, family } = resolveGenusAndFamily(qid, cache);
        const wikitext = buildWikitext(itemData, genus, family);
        if (wikitext) await db.push(';drafts;' + uriByQid[qid], wikitext);
    }

    await db.save();
    console.log(`Generated ${todo.length} Wikitext drafts.`);
}
