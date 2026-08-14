// @ts-check
// The findings database: the persistent worklist that replaces the cache/cache-*.json tombstones.
//
// Those files recorded only *that* a taxon had been checked, never what was found, while the
// results lived in files overwritten on every run — so a second run destroyed the first run's
// backlog. Here nothing is ever evicted: a row per (qid, kind) carries a status through its
// lifecycle, and the reports render from the accumulated backlog rather than from one run.
//
// Design notes in docs/findings-db-roadmap.md. The driver quirks (no .pluck(), no db.transaction(),
// run(...row) not run(row), null-prototype rows) are in docs/dev.md.
import { DatabaseSync } from 'node:sqlite';
import { ensureParentDir } from './paths.js';

/** Statuses that mean "settled" — discovery must never resurface these. */
export const STICKY_STATUSES = ['open', 'done', 'skipped', 'fixed_upstream', 'gone'];

/**
 * Statuses that are observations with a shelf life, not verdicts: CC photos keep being uploaded to
 * iNat and missing P225s keep being filled in, so these expire and become candidates again.
 */
export const NEGATIVE_STATUSES = ['no_photos', 'no_draft'];

/** Default age at which a negative result stops being trusted. */
export const DEFAULT_RECHECK_DAYS = 90;

// Ordered schema migrations; the array index + 1 is the resulting PRAGMA user_version.
const MIGRATIONS = [
    function v1(db) {
        db.exec(`
            CREATE TABLE taxa (
                qid        TEXT PRIMARY KEY,
                inat_id    TEXT,
                taxon_name TEXT,
                rank       TEXT,
                iucn       TEXT,
                first_seen TEXT NOT NULL
            ) STRICT;

            CREATE TABLE findings (
                id            INTEGER PRIMARY KEY,
                qid           TEXT NOT NULL REFERENCES taxa(qid),
                kind          TEXT NOT NULL,
                payload       TEXT,
                status        TEXT NOT NULL,
                discovered_at TEXT NOT NULL,
                checked_at    TEXT NOT NULL,
                verified_at   TEXT,
                resolved_at   TEXT,
                resolution    TEXT,
                UNIQUE (qid, kind)
            ) STRICT;

            CREATE INDEX idx_findings_worklist ON findings(kind, status);

            CREATE TABLE runs (
                id          INTEGER PRIMARY KEY,
                tool        TEXT NOT NULL,
                scope       TEXT,
                started_at  TEXT NOT NULL,
                finished_at TEXT,
                n_scanned   INTEGER,
                n_found     INTEGER
            ) STRICT;
        `);
    },
];

/**
 * Bring `db` up to the current schema version, one migration per transaction.
 * @param {DatabaseSync} db
 * @returns {number} the resulting schema version
 */
export function migrate(db) {
    const current = Number(db.prepare('PRAGMA user_version').get().user_version);
    for (let v = current; v < MIGRATIONS.length; v++) {
        db.exec('BEGIN');
        try {
            MIGRATIONS[v](db);
            db.exec(`PRAGMA user_version = ${v + 1}`); // index-derived, never user input
            db.exec('COMMIT');
        } catch (err) {
            db.exec('ROLLBACK');
            throw err;
        }
    }
    return MIGRATIONS.length;
}

/** ISO timestamp `days` in the past. ISO-8601 UTC strings sort chronologically, so `>` works. */
function cutoff(days) {
    return new Date(Date.now() - days * 86_400_000).toISOString();
}

const placeholders = (arr) => arr.map(() => '?').join(',');

/**
 * @typedef {{ qid: string, wdUri: string, inatTaxonId: string|null, taxonName: string|null, iucn: string|null, wikitext: string|null }} FindingRow
 */

/**
 * Build the query/write accessor over an open findings `db`. Split from openFindingsDb() so the
 * logic can be exercised against an in-memory SQLite fixture in tests — the same seam
 * `createTaxaAccessor` uses in lib/getInatTaxaDb.js.
 * @param {DatabaseSync} db
 */
export function createFindingsStore(db) {
    const stmtUpsertTaxon = db.prepare(`
        INSERT INTO taxa (qid, inat_id, taxon_name, rank, iucn, first_seen)
        VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(qid) DO UPDATE SET
            inat_id    = COALESCE(excluded.inat_id, inat_id),
            taxon_name = COALESCE(excluded.taxon_name, taxon_name),
            rank       = COALESCE(excluded.rank, rank),
            iucn       = COALESCE(excluded.iucn, iucn)`);

    // discovered_at is preserved on re-check; checked_at always moves forward.
    const stmtRecord = db.prepare(`
        INSERT INTO findings (qid, kind, payload, status, discovered_at, checked_at)
        VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(qid, kind) DO UPDATE SET
            payload    = excluded.payload,
            status     = excluded.status,
            checked_at = excluded.checked_at`);

    const stmtSkip = db.prepare(`
        SELECT qid FROM findings
        WHERE kind = ?
          AND (status IN (${placeholders(STICKY_STATUSES)})
               OR (status IN (${placeholders(NEGATIVE_STATUSES)}) AND checked_at > ?))`);

    // Deliberately narrow: touches status and the verification timestamps only. recordFinding()
    // would overwrite payload — and with payload undefined it writes NULL, which would wipe the
    // stored draft wikitext of every finding a verification pass looked at.
    const stmtVerifyOpen = db.prepare(`
        UPDATE findings SET verified_at = ? WHERE qid = ? AND kind = ?`);
    const stmtVerifyResolve = db.prepare(`
        UPDATE findings SET status = ?, verified_at = ?, resolved_at = ?, resolution = ?
        WHERE qid = ? AND kind = ?`);

    const stmtOpen = db.prepare(`
        SELECT f.qid, t.inat_id, t.taxon_name, t.iucn, f.payload
        FROM findings f
        JOIN taxa t ON t.qid = f.qid
        WHERE f.kind = ? AND f.status = 'open'
        ORDER BY f.discovered_at, f.qid`);

    const stmtCounts = db.prepare(
        'SELECT status, COUNT(*) AS n FROM findings WHERE kind = ? GROUP BY status');

    const stmtStartRun = db.prepare(
        'INSERT INTO runs (tool, scope, started_at) VALUES (?, ?, ?)');
    const stmtFinishRun = db.prepare(
        'UPDATE runs SET finished_at = ?, n_scanned = ?, n_found = ? WHERE id = ?');

    return {
        /**
         * QIDs discovery must skip: settled ones always, negative ones only while still inside the
         * recheck window. Returned as a Set so the SPARQL stream can filter without a query per row.
         * @param {string} kind
         * @param {number} [recheckAfterDays]
         * @returns {Set<string>}
         */
        skipQids(kind, recheckAfterDays = DEFAULT_RECHECK_DAYS) {
            const rows = stmtSkip.all(
                kind, ...STICKY_STATUSES, ...NEGATIVE_STATUSES, cutoff(recheckAfterDays));
            return new Set(rows.map(r => r.qid));
        },

        /** @param {{qid: string, inatId?: string|null, taxonName?: string|null, rank?: string|null, iucn?: string|null}} t */
        upsertTaxon(t) {
            stmtUpsertTaxon.run(
                t.qid, t.inatId ?? null, t.taxonName ?? null, t.rank ?? null, t.iucn ?? null,
                new Date().toISOString());
        },

        /**
         * Insert or refresh the finding for (qid, kind). A re-check overwrites status and payload
         * and moves checked_at; discovered_at keeps the original sighting.
         * @param {{qid: string, kind: string, status: string, payload?: unknown}} f
         */
        recordFinding(f) {
            const now = new Date().toISOString();
            stmtRecord.run(
                f.qid, f.kind, f.payload === undefined ? null : JSON.stringify(f.payload),
                f.status, now, now);
        },

        /**
         * Record the outcome of a verification check. Omit `status` to say "looked, still
         * actionable" — that only stamps verified_at and leaves everything else, including the
         * draft wikitext, untouched.
         * @param {string} qid
         * @param {string} kind
         * @param {{status?: string, resolution?: unknown}} [outcome]
         */
        markVerified(qid, kind, outcome = {}) {
            const now = new Date().toISOString();
            if (!outcome.status) {
                stmtVerifyOpen.run(now, qid, kind);
                return;
            }
            stmtVerifyResolve.run(
                outcome.status, now, now,
                outcome.resolution === undefined ? null : JSON.stringify(outcome.resolution),
                qid, kind);
        },

        /**
         * The whole open backlog for a kind — every run's findings, not just the last one.
         * @param {string} kind
         * @returns {FindingRow[]}
         */
        openFindings(kind) {
            return stmtOpen.all(kind).map(r => ({
                qid: r.qid,
                wdUri: `http://www.wikidata.org/entity/${r.qid}`,
                inatTaxonId: r.inat_id ?? null,
                taxonName: r.taxon_name ?? null,
                iucn: r.iucn ?? null,
                wikitext: r.payload ? JSON.parse(r.payload).wikitext ?? null : null,
            }));
        },

        /** @param {string} kind @returns {Record<string, number>} status → count */
        statusCounts(kind) {
            return Object.fromEntries(stmtCounts.all(kind).map(r => [r.status, Number(r.n)]));
        },

        /** @param {string} tool @param {unknown} scope @returns {number} run id */
        startRun(tool, scope) {
            const info = stmtStartRun.run(
                tool, scope === undefined ? null : JSON.stringify(scope),
                new Date().toISOString());
            return Number(info.lastInsertRowid);
        },

        /** @param {number} id @param {{scanned: number, found: number}} counts */
        finishRun(id, counts) {
            stmtFinishRun.run(new Date().toISOString(), counts.scanned, counts.found, id);
        },

        close() { db.close(); },
    };
}

/**
 * Open (creating if needed) the findings database and return its store, migrated to the current
 * schema. Unlike the taxa index this holds state that cannot be regenerated, so it lives in
 * `data/` rather than `cache/` and is never dropped and rebuilt.
 * @param {string} file
 */
export function openFindingsDb(file) {
    const db = new DatabaseSync(ensureParentDir(file));
    db.exec('PRAGMA journal_mode = WAL');
    db.exec('PRAGMA busy_timeout = 5000');
    db.exec('PRAGMA foreign_keys = ON');
    db.exec('PRAGMA synchronous = NORMAL');
    migrate(db);
    return createFindingsStore(db);
}
