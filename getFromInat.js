import fs from 'fs';
import { JsonDB, Config } from 'node-json-db';

let db = new JsonDB(new Config("inattWDPhotoCache", true, false, ';'));


fs.readFile('./inatIDsToDo.json', 'utf8', async (err, jsonString) => {
    if (err) {
        console.log("File read failed:", err)
        return
    }
    const map = new Map(Object.entries(JSON.parse(jsonString)))
    
    
    for(const [key, val] of map){

        try {
            let data = await db.getData(";done;" + key);
        }catch(error){
            await getObservationsForTaxa(key, val, db);
            await delay(1000);
        }

        
    }


})


function delay(milliseconds){
    return new Promise(resolve => {
        setTimeout(resolve, milliseconds);
    });
}

async function  getObservationsForTaxa(key, val, db, license = 'CC0') {
    let inatQuery = {
        taxon_id: key,
        photo_license: license,
        quality_grade: 'research'
    };

    let inatURL = 'https://www.inaturalist.org/observations.json?' + new URLSearchParams(inatQuery);

    let respo = await fetch(inatURL, {method: 'GET'})
    let respoJson = await respo.json();
    if(respoJson[0]){
        //available.add(val);
        db.push(";available;" + val, true);
    }
    
    db.push(";done;" + key, true);
    
}