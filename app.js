import WBK from 'wikibase-sdk';
import fs from 'fs';
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

getInatIdToWD("inatIDsToDo.json", limit);

function getInatIdToWD(outFile, limit) {
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

    const url = wbk.sparqlQuery(sparql);

    const headers = { 'User-Agent': 'wikidata-inat-checker/1.0.0 (https://github.com/Livia-Rasp/wikidata-inat-checker)' };

    fetch(url, { headers }).then(response => response.json()).then(jsonRes => {
        let inatToWD = new Map();
        for (const i in jsonRes.results.bindings) {
            const element = jsonRes.results.bindings[i];
            inatToWD.set(element.inatID.value, element.item.value);
        }
        return (inatToWD);
    }).then(async inatToWD => {
        const obj = Object.fromEntries(inatToWD);

        fs.writeFile(outFile, JSON.stringify(obj, null, 2), 'utf8', function (err) {
            if (err) {
                console.log("An error occured while writing JSON Object to File.");
                return console.log(err);
            }

            console.log("JSON file has been saved.");
        });

        console.log("Checking " + inatToWD.size + " taxa against iNat for CC0 photos...");
        await processInatIds(inatToWD);
        console.log("iNat check complete.");
        await generateDraftWikitext();
        console.log("Draft Wikitext generation complete.");
        await generateDraftsHTML();
        console.log("HTML export complete.");
    });
}



