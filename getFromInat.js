import { JsonDB, Config } from 'node-json-db';

const db = new JsonDB(new Config("inattWDPhotoCache", false, true, ';'));

const CONCURRENCY = 3;
const REQUEST_INTERVAL_MS = 1000;
const SAVE_EVERY = 50;

async function getObservationsForTaxa(key, val, license = 'CC0,CC-BY,CC-BY-SA') {
    const inatQuery = {
        taxon_id: key,
        photo_license: license,
        quality_grade: 'research',
        per_page: 1
    };

    const inatURL = 'https://www.inaturalist.org/observations.json?' + new URLSearchParams(inatQuery);

    const respo = await fetch(inatURL, { method: 'GET' });
    const respoJson = await respo.json();
    if (respoJson[0]) {
        await db.push(";available;" + val, true);
    }

    await db.push(";done;" + key, true);
}

let nextSlot = 0;
async function rateLimit() {
    const now = Date.now();
    const slot = Math.max(now, nextSlot);
    nextSlot = slot + REQUEST_INTERVAL_MS;
    const wait = slot - now;
    if (wait > 0) await new Promise(resolve => setTimeout(resolve, wait));
}

export async function processInatIds(map) {
    const todo = [];
    for (const [key, val] of map) {
        if (!(await db.exists(";done;" + key))) todo.push([key, val]);
    }
    console.log(`${todo.length} taxa to query (skipping ${map.size - todo.length} already done)`);

    let cursor = 0;
    let processed = 0;
    let sinceSave = 0;

    const flushOnExit = async () => {
        await db.save();
        process.exit(0);
    };
    process.once('SIGINT', flushOnExit);

    const worker = async () => {
        while (cursor < todo.length) {
            const [key, val] = todo[cursor++];
            await rateLimit();
            try {
                await getObservationsForTaxa(key, val);
            } catch (error) {
                console.error('error for taxon', key, error.message);
            }
            processed++;
            sinceSave++;
            if (sinceSave >= SAVE_EVERY) {
                sinceSave = 0;
                await db.save();
            }
            if (processed % 100 === 0) {
                console.log(`progress: ${processed}/${todo.length}`);
            }
        }
    };

    await Promise.all(Array.from({ length: CONCURRENCY }, worker));
    await db.save();
}
