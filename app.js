const wbk = require('wikibase-sdk')({
    instance: 'https://www.wikidata.org',
    sparqlEndpoint: 'https://query.wikidata.org/sparql'
  })

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
} LIMIT 500`

const url = wbk.sparqlQuery(sparql)

const headers = { 'Api-User-Agent': 'Example/1.0' };



fetch(url).then(response => response.json()).then(jsonRes => {
    let inatToWD = new Map();
    for(i in jsonRes.results.bindings){
        const element = jsonRes.results.bindings[i];
        inatToWD.set(element.inatID.value, element.item.value);
    }
    return (inatToWD);
}).then(map => console.log(map))

