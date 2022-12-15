const fs = require('fs');

let doneSet = new Set();
let available = new Set();

fs.readFile('./inatIDsToDo.json', 'utf8', async (err, jsonString) => {
    if (err) {
        console.log("File read failed:", err)
        return
    }
    const map = new Map(Object.entries(JSON.parse(jsonString)))
    
    
    for([key, val] of map){
        await getObservationsForTaxa(key, val, available);
        await delay(1000);
    }

    console.log(available);

})


function delay(milliseconds){
    return new Promise(resolve => {
        setTimeout(resolve, milliseconds);
    });
}

async function  getObservationsForTaxa(key, val, available, license = 'CC0') {
    let inatQuery = {
        taxon_id: key,
        photo_license: license,
        quality_grade: 'research'
    };

    let inatURL = 'https://www.inaturalist.org/observations.json?' + new URLSearchParams(inatQuery);

    let respo = await fetch(inatURL, {method: 'GET'})
    let respoJson = await respo.json();
    if(respoJson[0]){
        available.add(val);
    }
    
    
}