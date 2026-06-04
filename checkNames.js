import WBK from 'wikibase-sdk';
import { simplify } from 'wikibase-sdk';
import pLimit from 'p-limit';
import { fetchEntities, chunk } from './generateWikitext.js';
import { fetchInatNames } from './getInatNames.js';
import { generateNamesHTML } from './generateNamesHTML.js';

const wbk = WBK({
    instance: 'https://www.wikidata.org',
    sparqlEndpoint: 'https://query.wikidata.org/sparql'
});

const DEFAULT_LIMIT = 5000;
const limitArg = Number.parseInt(process.argv[2], 10);
const limit = Number.isFinite(limitArg) && limitArg > 0 ? limitArg : DEFAULT_LIMIT;

const HEADERS = { 'User-Agent': 'wikidata-inat-checker/1.0.0 (https://github.com/Livia-Rasp/wikidata-inat-checker)' };

function qidFromUri(uri) { return uri.split('/').pop(); }

async function run(limit) {
    const sparql = `SELECT ?item ?inatID
WHERE {
  ?item wdt:P31 wd:Q16521 .
  ?item wdt:P3151 ?inatID .
} LIMIT ${limit}`;

    const response = await fetch(wbk.sparqlQuery(sparql), { headers: HEADERS });
    const jsonRes = await response.json();

    const inatToWD = new Map();
    for (const binding of jsonRes.results.bindings) {
        inatToWD.set(binding.inatID.value, binding.item.value);
    }
    console.log(`Found ${inatToWD.size} taxa with iNat IDs.`);

    // Fetch P225 + P1843 from Wikidata for all items
    const wdUris = [...inatToWD.values()];
    const qids = wdUris.map(qidFromUri);
    console.log(`Fetching Wikidata vernacular names for ${qids.length} items...`);

    const concurrency = pLimit(4);
    const batches = chunk(qids, 50);
    const entityResults = await Promise.all(batches.map(b => concurrency(() => fetchEntities(b))));

    const wdData = {};
    for (const data of entityResults) {
        for (const [qid, entity] of Object.entries(data.entities || {})) {
            if (entity.missing) continue;
            const claims = simplify.claims(entity.claims || {}, { keepRichValues: true });
            const taxonName = claims.P225?.[0];
            const wdNames = new Set(
                (claims.P1843 || []).map(v => `${v.language}:${v.text.toLowerCase()}`)
            );
            wdData[qid] = { taxonName, wdNames };
        }
    }
    console.log('Wikidata fetch complete.');

    // Fetch iNat vernacular names
    const inatIds = [...inatToWD.keys()];
    console.log(`Fetching iNat vernacular names for ${inatIds.length} taxa...`);
    const inatNames = await fetchInatNames(inatIds);
    console.log('iNat fetch complete.');

    // Diff: collect names present in iNat but absent from Wikidata P1843
    const items = [];
    for (const [inatId, wdUri] of inatToWD) {
        const qid = qidFromUri(wdUri);
        const wd = wdData[qid];
        if (!wd) continue;

        const inatEntries = inatNames.get(inatId) || [];
        const sciName = wd.taxonName?.toLowerCase();
        const missing = inatEntries.filter(({ locale, name }) =>
            !wd.wdNames.has(`${locale}:${name.toLowerCase()}`) &&
            name.toLowerCase() !== sciName
        );
        if (missing.length > 0) {
            items.push({ wdUri, qid, inatId, taxonName: wd.taxonName, missing });
        }
    }
    console.log(`Found ${items.length} items with missing vernacular names.`);

    await generateNamesHTML(items);
    console.log('HTML export complete.');
}

run(limit).catch(err => {
    console.error('Fatal error:', err);
    process.exit(1);
});
