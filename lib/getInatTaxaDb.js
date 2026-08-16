// @ts-check
import fs from 'fs';
import path from 'path';
import os from 'os';
import zlib from 'zlib';
import { DatabaseSync } from 'node:sqlite';
import { HEADERS } from './utils.js';

/**
 * @typedef {{ inatId: string, rank: string }} TaxonEntry
 */

const TAXA_URL  = 'https://inaturalist-open-data.s3.amazonaws.com/taxa.csv.gz';
const CACHE_DIR = path.join(os.homedir(), '.cache', 'wikidata-inat-checker');
const TSV_FILE  = path.join(CACHE_DIR, 'taxa.csv.gz');
const DB_FILE   = path.join(CACHE_DIR, 'taxa.db');
const MAX_AGE_DAYS = 30;

/** Uninomials read from the index before `suggest` ranks them. See the comment there. */
const UNINOMIAL_WINDOW = 400;

/**
 * Rank ordering for suggestions, higher taxa first. Ancestry *depth* was the obvious
 * vocabulary-free proxy and it does not work: lineages vary enormously in how many intermediate
 * ranks they carry, so a genus in a shallow group outranks a family in a deep one, and 'Orch'
 * answers Orchesellaria before Orchidaceae. Ranks iNat invents later simply land in the middle.
 */
const RANK_ORDER = {
    stateofmatter: 0, kingdom: 10, subkingdom: 11, phylum: 20, subphylum: 21, superclass: 25,
    class: 30, subclass: 31, infraclass: 32, superorder: 35, order: 40, suborder: 41,
    infraorder: 42, parvorder: 43, zoosection: 44, zoosubsection: 45, superfamily: 46,
    epifamily: 47, family: 50, subfamily: 51, supertribe: 52, tribe: 53, subtribe: 54,
    genus: 60, genushybrid: 61, subgenus: 62, section: 63, subsection: 64, complex: 65,
    species: 70, hybrid: 71, subspecies: 80, variety: 81, form: 82,
};
const UNRANKED = 65;

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
        const db = new DatabaseSync(DB_FILE, { readOnly: true });
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

    const db = new DatabaseSync(DB_FILE);
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

    // header: taxon_id\tancestry\trank_level\trank\tname\tactive
    const rows = [];
    for (let i = 1; i < lines.length; i++) {
        const cols = lines[i].split('\t');
        if (cols.length < 6 || cols[5].trim() !== 'true') continue;
        const [taxonId, ancestry, , rank, name] = cols.map(c => c.trim());
        if (!name || !taxonId) continue;
        rows.push([taxonId, name, rank, ancestry || null]);
    }

    // node:sqlite has no transaction() helper, so the bulk insert is wrapped by hand — without it
    // every run() commits on its own and the ~3M-row build crawls. Parameters must be spread:
    // run() binds positionally and rejects a single array argument.
    db.exec('BEGIN');
    try {
        for (const r of rows) insert.run(...r);
        db.exec('COMMIT');
    } catch (err) {
        db.exec('ROLLBACK');
        throw err;
    }
    db.close();
    console.log(`SQLite index built (${rows.length} active taxa).`);
}

/**
 * @typedef {{ inatId: string, name: string, rank: string }} TaxonRecord
 */

/**
 * @typedef {{ get(name: string): TaxonEntry | undefined, getAll(name: string): TaxonEntry[], getAncestors(taxonId: string): {name: string, rank: string}[], allNames(): string[], allInatIds(): string[], descendantInatIds(taxonId: string): string[], ancestorIds(taxonId: string): string[], byId(taxonId: string): TaxonRecord | undefined, lineage(taxonId: string): TaxonRecord[], suggest(prefix: string, limit?: number): TaxonRecord[] }} TaxaAccessor
 */

/**
 * The exclusive upper bound of a prefix range: 'Orchid' → 'Orchie'. This is what lets `suggest`
 * be a range scan over `idx_name` instead of a `LIKE`, which SQLite cannot serve from an index
 * on a BINARY-collated column. Undefined for an empty prefix or one ending in U+FFFF, which have
 * no bound to scan up to.
 * @param {string} prefix
 * @returns {string | undefined}
 */
export function prefixUpperBound(prefix) {
    const last = prefix.charCodeAt(prefix.length - 1);
    if (Number.isNaN(last) || last >= 0xffff) return undefined;
    return prefix.slice(0, -1) + String.fromCharCode(last + 1);
}

/**
 * Build the query accessor over an open taxa `db` (schema `taxa(taxon_id, name, rank,
 * ancestry)`). Separated from the loaders so the query logic can be exercised against an
 * in-memory SQLite fixture in tests without downloading the ~180 MB dump.
 * @param {import('node:sqlite').DatabaseSync} db
 * @returns {TaxaAccessor}
 */
export function createTaxaAccessor(db) {
    const stmtByName    = db.prepare('SELECT taxon_id, rank FROM taxa WHERE name = ? LIMIT 2');
    const stmtAllByName = db.prepare('SELECT taxon_id, rank FROM taxa WHERE name = ?');
    const stmtById      = db.prepare('SELECT name, rank FROM taxa WHERE taxon_id = ?');
    const stmtAnc       = db.prepare('SELECT ancestry FROM taxa WHERE taxon_id = ?');
    const stmtAllNames  = db.prepare('SELECT DISTINCT name FROM taxa');
    const stmtAllIds    = db.prepare('SELECT taxon_id FROM taxa');
    const stmtDesc      = db.prepare(
        'SELECT taxon_id FROM taxa WHERE ancestry = ? OR ancestry LIKE ? OR ancestry LIKE ? OR ancestry LIKE ?');
    const stmtRecord    = db.prepare('SELECT taxon_id, name, rank FROM taxa WHERE taxon_id = ?');
    // A range over idx_name, not a LIKE: `name LIKE 'Orch%'` cannot use an index on a
    // BINARY-collated column, and this table has 3M rows, so the difference is a scan.
    const stmtPrefix    = db.prepare(
        'SELECT taxon_id, name, rank, ancestry FROM taxa WHERE name >= ? AND name < ? ORDER BY name LIMIT ?');
    // Uninomials — genus and above — asked for separately rather than filtered out of the range
    // afterwards. Ordering the range alphabetically answers 'Panth' with two dozen Panthalis and
    // Panthea species and never reaches Panthera, however far the window is widened. SQLite walks
    // idx_name for the range and stops at LIMIT, so this costs a few hundred rows, not the range.
    const stmtPrefixUni = db.prepare(
        `SELECT taxon_id, name, rank, ancestry FROM taxa
         WHERE name >= ? AND name < ? AND name NOT LIKE '% %' ORDER BY name LIMIT ?`);

    // node:sqlite hands back null-prototype rows; every accessor below copies into plain objects
    // so callers get what the typedef promises and nothing downstream trips over the prototype.
    const record = (r) => (r ? { inatId: r.taxon_id, name: r.name, rank: r.rank } : undefined);

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
                .filter(a => a.rank !== 'stateofmatter')   // drop iNat's root concept
                // node:sqlite hands back null-prototype rows; copy into plain objects so callers
                // get what the typedef promises and nothing downstream trips over the prototype.
                .map(a => ({ name: a.name, rank: a.rank }));
        },
        allNames() {
            return stmtAllNames.all().map(r => r.name);
        },
        allInatIds() {
            return stmtAllIds.all().map(r => r.taxon_id);
        },
        descendantInatIds(taxonId) {
            // ancestry is a '/'-separated path of ancestor ids with no leading slash and no
            // self. The id is a whole path component in one of four positions: the entire
            // string (`<id>`), the start (`<id>/...`), the end (`.../<id>`, i.e. a *direct*
            // child), or the middle (`.../<id>/...`). All four must be matched — omitting the
            // end position silently drops every direct child (e.g. a genus's own species).
            return stmtDesc.all(
                `${taxonId}`, `${taxonId}/%`, `%/${taxonId}`, `%/${taxonId}/%`).map(r => r.taxon_id);
        },
        // The counterpart to descendantInatIds, and the one the backlog filter uses: asking a taxon
        // for its ancestors is a primary-key read, while asking a clade for its descendants is an
        // unindexed scan of the whole table. See docs/dev.md.
        ancestorIds(taxonId) {
            const row = stmtAnc.get(taxonId);
            return row?.ancestry ? String(row.ancestry).split('/').filter(Boolean) : [];
        },
        byId(taxonId) {
            return record(stmtRecord.get(taxonId));
        },
        // getAncestors without the ids is enough to render a lineage but not to navigate one, so
        // this returns records. The same two filters apply: ancestors that are no longer active are
        // absent from the index, and iNat's root concept is not a rank anyone wants to see.
        lineage(taxonId) {
            const row = stmtAnc.get(taxonId);
            if (!row?.ancestry) return [];
            return String(row.ancestry).split('/').filter(Boolean)
                .map(id => record(stmtRecord.get(id)))
                .filter(a => a && a.rank !== 'stateofmatter');
        },
        // Higher taxa first, then the shortest name. Someone typing a few letters is nearly always
        // reaching for a clade, and plain alphabetical order answers 'Orchi' with ten Orchidantha
        // species and buries Orchidaceae. Name length is the tie-break because a prefix that is
        // nearly the whole name is likelier to be the target: 'Panth' means Panthera far more often
        // than Panthalis, and both are genera so rank cannot separate them.
        suggest(prefix, limit = 10) {
            const upper = prefixUpperBound(prefix);
            if (upper === undefined) return [];
            const rank = (rows) => rows
                .map(r => ({ ...record(r), _order: RANK_ORDER[r.rank] ?? UNRANKED }))
                .sort((a, b) => a._order - b._order
                    || a.name.length - b.name.length
                    || a.name.localeCompare(b.name));

            // The uninomial window is wide on purpose. Depth can only reorder what was fetched, and
            // the fetch is alphabetical, so a narrow window answers 'Orch' with Orchadocarpa and
            // Orchamoplatus and never reaches Orchidaceae. 400 index rows is still microseconds.
            const seen = new Set();
            const out = [];
            for (const r of [...rank(stmtPrefixUni.all(prefix, upper, UNINOMIAL_WINDOW)),
                             ...rank(stmtPrefix.all(prefix, upper, limit * 2))]) {
                if (seen.has(r.inatId)) continue;
                seen.add(r.inatId);
                out.push({ inatId: r.inatId, name: r.name, rank: r.rank });
                if (out.length === limit) break;
            }
            return out;
        }
    };
}

/**
 * Returns a read-only handle to the local iNat taxa SQLite index, **downloading (~189 MB) and
 * rebuilding it if stale or missing** — minutes of work, so this is for the CLI only. The server
 * gets a counterpart that refuses to build in the next commit.
 * undefined from .get() means not found or a homonym (2+ active taxa share the same name).
 * @returns {Promise<TaxaAccessor>}
 */
/** Why the index cannot be opened, with a message that says what to do about it. */
export class TaxaIndexUnavailable extends Error {
    /** @param {string} reason @param {string} message */
    constructor(reason, message) {
        super(message);
        this.name = 'TaxaIndexUnavailable';
        this.code = 'taxa_index_unavailable';
        this.reason = reason;
    }
}

/**
 * Open the existing index read-only, or throw. **Never downloads and never builds** — that path
 * is 189 MB and minutes of a wedged process, which is not something an HTTP request may set off.
 * The server uses this; the CLI uses {@link ensureTaxaDb}.
 *
 * The schema check is not decoration: `dbIsStale` treats a missing `ancestry` column as "rebuild",
 * so without checking it here a caller would get a handle whose queries throw at the first scope
 * resolution rather than a clear failure at open time.
 *
 * @returns {TaxaAccessor}
 */
export function openTaxaDb() {
    if (!fs.existsSync(DB_FILE)) {
        throw new TaxaIndexUnavailable('missing',
            `The iNat taxa index is not built (${DB_FILE}). Run a checker from a terminal first — `
            + 'building it downloads ~189 MB and takes minutes, so it is deliberately not something '
            + 'the server will do for you.');
    }
    let db;
    try {
        db = new DatabaseSync(DB_FILE, { readOnly: true });
    } catch (err) {
        throw new TaxaIndexUnavailable('unreadable', `The iNat taxa index could not be opened: ${err.message}`);
    }
    const cols = db.prepare('PRAGMA table_info(taxa)').all();
    if (!cols.some(c => c.name === 'ancestry')) {
        db.close();
        throw new TaxaIndexUnavailable('outdated',
            'The iNat taxa index predates the ancestry column. Run a checker from a terminal to rebuild it.');
    }
    return createTaxaAccessor(db);
}

/** Is the index old enough that a CLI run would rebuild it? Advisory — openTaxaDb serves it anyway. */
export function taxaIndexIsStale() {
    return tsvIsStale();
}

export async function ensureTaxaDb() {
    if (tsvIsStale()) await downloadTaxa();
    if (dbIsStale()) buildDb();
    return createTaxaAccessor(new DatabaseSync(DB_FILE, { readOnly: true }));
}
