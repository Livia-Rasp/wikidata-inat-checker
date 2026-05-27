import { JsonDB, Config } from 'node-json-db';

const db = new JsonDB(new Config("inattWDPhotoCache", true, true, ';'));

function delay(milliseconds) {
    return new Promise(resolve => setTimeout(resolve, milliseconds));
}

async function getObservationsForTaxa(key, val, license = 'CC0') {
    const inatQuery = {
        taxon_id: key,
        photo_license: license,
        quality_grade: 'research'
    };

    const inatURL = 'https://www.inaturalist.org/observations.json?' + new URLSearchParams(inatQuery);

    const respo = await fetch(inatURL, { method: 'GET' });
    const respoJson = await respo.json();
    if (respoJson[0]) {
        await db.push(";available;" + val, true);
    }

    await db.push(";done;" + key, true);
}

export async function processInatIds(map) {
    for (const [key, val] of map) {
        try {
            await db.getData(";done;" + key);
        } catch (error) {
            await getObservationsForTaxa(key, val);
            await delay(1000);
        }
    }
}
