import WBK from 'wikibase-sdk';
import { processInatIds } from './getFromInat.js';
import { generateDraftWikitext } from './generateWikitext.js';
import { generateDraftsHTML } from './generateHTML.js';

const wbk = WBK({
    instance: 'https://www.wikidata.org',
    sparqlEndpoint: 'https://query.wikidata.org/sparql'
});

const DEFAULT_LIMIT = 5000;
const limitArg = Number.parseInt(process.argv[2], 10);
const limit = Number.isFinite(limitArg) && limitArg > 0 ? limitArg : DEFAULT_LIMIT;

async function run(limit) {
    const sparql = `SELECT ?item ?inatID
WHERE
{
  ?item wdt:P31 wd:Q16521 .
  ?item wdt:P3151 ?inatID .
  FILTER (
     !EXISTS {
     ?item p:P18 ?statement1.
       }
    )
} LIMIT ${limit}`;

    const headers = { 'User-Agent': 'wikidata-inat-checker/1.0.0 (https://github.com/Livia-Rasp/wikidata-inat-checker)' };
    const response = await fetch(wbk.sparqlQuery(sparql), { headers });
    const jsonRes = await response.json();

    const inatToWD = new Map();
    for (const binding of jsonRes.results.bindings) {
        inatToWD.set(binding.inatID.value, binding.item.value);
    }
    console.log(`Found ${inatToWD.size} taxa without images.`);

    console.log(`Checking ${inatToWD.size} taxa against iNat for CC0 photos...`);
    const { available, inatTaxonIds } = await processInatIds(inatToWD);
    console.log("iNat check complete.");

    const drafts = await generateDraftWikitext(available);
    console.log("Draft Wikitext generation complete.");

    await generateDraftsHTML(drafts, inatTaxonIds);
    console.log("HTML export complete.");
}

run(limit).catch(err => {
    console.error('Fatal error:', err);
    process.exit(1);
});
