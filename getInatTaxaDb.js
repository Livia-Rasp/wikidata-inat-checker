import fs from 'fs';
import path from 'path';
import os from 'os';
import zlib from 'zlib';
import { HEADERS } from './utils.js';

const TAXA_URL = 'https://inaturalist-open-data.s3.amazonaws.com/taxa.csv.gz';
const CACHE_DIR = path.join(os.homedir(), '.cache', 'wikidata-inat-checker');
const CACHE_FILE = path.join(CACHE_DIR, 'taxa.csv.gz');
const MAX_AGE_DAYS = 30;

function isStale() {
    try {
        const ageDays = (Date.now() - fs.statSync(CACHE_FILE).mtimeMs) / 86_400_000;
        return ageDays > MAX_AGE_DAYS;
    } catch { return true; }
}

async function downloadTaxa() {
    fs.mkdirSync(CACHE_DIR, { recursive: true });
    console.log('Downloading iNat taxa database (~39 MB)...');
    const res = await fetch(TAXA_URL, { headers: HEADERS });
    if (!res.ok) throw new Error(`Failed to download taxa: HTTP ${res.status}`);
    fs.writeFileSync(CACHE_FILE, Buffer.from(await res.arrayBuffer()));
    console.log('Taxa database downloaded and cached.');
}

export async function loadTaxaDb() {
    if (isStale()) await downloadTaxa();
    console.log('Loading iNat taxa database...');
    const raw = fs.readFileSync(CACHE_FILE);
    // fetch auto-decompresses Content-Encoding:gzip, so the cached file may be plain text
    const isGzip = raw[0] === 0x1f && raw[1] === 0x8b;
    const lines = (isGzip ? zlib.gunzipSync(raw) : raw).toString('utf8').split('\n');
    // header: taxon_id\tancestry\trank_level\trank\tname\tactive
    const seen = new Map();   // name → count of active entries
    const result = new Map(); // name → {inatId, rank} | null (null = homonym ambiguity)
    for (let i = 1; i < lines.length; i++) {
        const cols = lines[i].split('\t');
        if (cols.length < 6 || cols[5].trim() !== 'true') continue;
        const [inatId, , , rank, name] = cols.map(c => c.trim());
        if (!name || !inatId) continue;
        const n = (seen.get(name) ?? 0) + 1;
        seen.set(name, n);
        result.set(name, n === 1 ? { inatId, rank } : null);
    }
    console.log(`Loaded ${result.size} unique taxon names from iNat taxa database.`);
    return result;
}
