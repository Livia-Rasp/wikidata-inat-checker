// @ts-check
import fs from 'fs';
import path from 'path';
import os from 'os';
import zlib from 'zlib';
import Database from 'better-sqlite3';
import { HEADERS } from './utils.js';

/**
 * @typedef {{ inatId: string, rank: string }} TaxonEntry
 */

const TAXA_URL  = 'https://inaturalist-open-data.s3.amazonaws.com/taxa.csv.gz';
const CACHE_DIR = path.join(os.homedir(), '.cache', 'wikidata-inat-checker');
const TSV_FILE  = path.join(CACHE_DIR, 'taxa.csv.gz');
const DB_FILE   = path.join(CACHE_DIR, 'taxa.db');
const MAX_AGE_DAYS = 30;

function tsvIsStale() {
    try {
        return (Date.now() - fs.statSync(TSV_FILE).mtimeMs) / 86_400_000 > MAX_AGE_DAYS;
    } catch { return true; }
}

function dbIsStale() {
    try {
        const tsvNewer = fs.statSync(TSV_FILE).mtimeMs > fs.statSync(DB_FILE).mtimeMs;
        if (tsvNewer) return true;
        // Rebuild if ancestry column is missing (schema migration)
        const db = new Database(DB_FILE, { readonly: true });
        const cols = db.prepare('PRAGMA table_info(taxa)').all();
        db.close();
        return !cols.some(c => c.name === 'ancestry');
    } catch { return true; }
}

async function downloadTaxa() {
    fs.mkdirSync(CACHE_DIR, { recursive: true });
    console.log('Downloading iNat taxa database (~180 MB)...');
    const res = await fetch(TAXA_URL, { headers: HEADERS });
    if (!res.ok) throw new Error(`Failed to download taxa: HTTP ${res.status}`);
    fs.writeFileSync(TSV_FILE, Buffer.from(await res.arrayBuffer()));
    console.log('Taxa database downloaded.');
}

function buildDb() {
    console.log('Building SQLite taxa index...');
    const raw = fs.readFileSync(TSV_FILE);
    // fetch auto-decompresses Content-Encoding:gzip, so the cached file may be plain text
    const isGzip = raw[0] === 0x1f && raw[1] === 0x8b;
    const lines = (isGzip ? zlib.gunzipSync(raw) : raw).toString('utf8').split('\n');

    const db = new Database(DB_FILE);
    db.exec(`
        DROP TABLE IF EXISTS taxa;
        CREATE TABLE taxa (
            taxon_id TEXT PRIMARY KEY,
            name     TEXT NOT NULL,
            rank     TEXT NOT NULL,
            ancestry TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_name ON taxa(name);
    `);

    const insert = db.prepare('INSERT OR IGNORE INTO taxa VALUES (?, ?, ?, ?)');
    const insertAll = db.transaction(rows => { for (const r of rows) insert.run(r); });

    // header: taxon_id\tancestry\trank_level\trank\tname\tactive
    const rows = [];
    for (let i = 1; i < lines.length; i++) {
        const cols = lines[i].split('\t');
        if (cols.length < 6 || cols[5].trim() !== 'true') continue;
        const [taxonId, ancestry, , rank, name] = cols.map(c => c.trim());
        if (!name || !taxonId) continue;
        rows.push([taxonId, name, rank, ancestry || null]);
    }
    insertAll(rows);
    db.close();
    console.log(`SQLite index built (${rows.length} active taxa).`);
}

/**
 * Returns a read-only handle to the local iNat taxa SQLite index, downloading and building it if needed.
 * undefined from .get() means not found or a homonym (2+ active taxa share the same name).
 * @returns {Promise<{ get(name: string): TaxonEntry | undefined, getAll(name: string): TaxonEntry[], getAncestors(taxonId: string): {name: string, rank: string}[], allNames(): string[], allInatIds(): string[], descendantInatIds(taxonId: string): string[] }>}
 */
export async function loadTaxaDb() {
    if (tsvIsStale()) await downloadTaxa();
    if (dbIsStale()) buildDb();

    const db = new Database(DB_FILE, { readonly: true });
    const stmtByName    = db.prepare('SELECT taxon_id, rank FROM taxa WHERE name = ? LIMIT 2');
    const stmtAllByName = db.prepare('SELECT taxon_id, rank FROM taxa WHERE name = ?');
    const stmtById      = db.prepare('SELECT name, rank FROM taxa WHERE taxon_id = ?');
    const stmtAnc       = db.prepare('SELECT ancestry FROM taxa WHERE taxon_id = ?');
    const stmtAllNames  = db.prepare('SELECT DISTINCT name FROM taxa');
    const stmtAllIds    = db.prepare('SELECT taxon_id FROM taxa');
    const stmtDesc      = db.prepare('SELECT taxon_id FROM taxa WHERE ancestry LIKE ? OR ancestry LIKE ?');

    return {
        get(name) {
            const rows = stmtByName.all(name);
            if (rows.length !== 1) return undefined; // not found or homonym ambiguity
            return { inatId: rows[0].taxon_id, rank: rows[0].rank };
        },
        getAll(name) {
            return stmtAllByName.all(name).map(r => ({ inatId: r.taxon_id, rank: r.rank }));
        },
        getAncestors(taxonId) {
            const row = stmtAnc.get(taxonId);
            if (!row?.ancestry) return [];
            return row.ancestry.split('/').filter(Boolean)
                .map(id => stmtById.get(id))
                .filter(Boolean)                           // skip inactive ancestors absent from DB
                .filter(a => a.rank !== 'stateofmatter'); // drop iNat's root concept
        },
        allNames() {
            return stmtAllNames.pluck().all();
        },
        allInatIds() {
            return stmtAllIds.pluck().all();
        },
        descendantInatIds(taxonId) {
            // ancestry is a '/'-separated path with no leading slash, so the id is a
            // component either at the start (`<id>/...`) or in the middle (`.../<id>/...`).
            return stmtDesc.pluck().all(`${taxonId}/%`, `%/${taxonId}/%`);
        }
    };
}
