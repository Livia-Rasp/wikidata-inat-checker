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

    // v2: what has been uploaded to Commons, and which photo is this taxon's pending P18 pick.
    // Both lived in localStorage, where the checkers could not see them and a cleared browser
    // profile destroyed them — and the pick in particular was deleted the moment the
    // QuickStatements were copied, so nothing recorded which file an edit was meant to use.
    function v2(db) {
        db.exec(`
            CREATE TABLE uploads (
                id         INTEGER PRIMARY KEY,
                dest_file  TEXT NOT NULL UNIQUE,
                qid        TEXT REFERENCES taxa(qid),
                photo_id   TEXT,
                taxon_name TEXT,
                is_p18     INTEGER NOT NULL DEFAULT 0,
                created_at TEXT NOT NULL
            ) STRICT;

            CREATE INDEX idx_uploads_qid ON uploads(qid);

            -- At most one P18 pick per taxon, enforced by the database rather than by convention.
            CREATE UNIQUE INDEX idx_uploads_p18 ON uploads(qid) WHERE is_p18 = 1;
        `);
    },

    // v3: how a run ended. `finished_at IS NULL` used to mean both "still going" and "died without
    // saying so", which is the wrong ambiguity for the one operation that spends API reputation —
    // a killed run left a row that looked in-progress forever.
    function v3(db) {
        db.exec(`
            ALTER TABLE runs ADD COLUMN state TEXT NOT NULL DEFAULT 'running';
            ALTER TABLE runs ADD COLUMN error TEXT;
            UPDATE runs SET state = 'done' WHERE finished_at IS NOT NULL;
            UPDATE runs SET state = 'interrupted' WHERE finished_at IS NULL;
        `);
    },

    // v4 (slice 5b): triggered_by tells a scheduled top-up apart from a manual one in the run log,
    // and request_log is the traffic history a scheduler derives quiet hours from. Both new, so
    // one migration, matching v1's precedent of bundling several related objects together.
    function v4(db) {
        db.exec(`
            ALTER TABLE runs ADD COLUMN triggered_by TEXT NOT NULL DEFAULT 'manual';

            CREATE TABLE request_log (
                hour_bucket TEXT PRIMARY KEY,
                count       INTEGER NOT NULL DEFAULT 0
            ) STRICT;
        `);
    },
];

/** Terminal run states. `interrupted` means the process died before it could say anything. */
export const RUN_STATES = ['running', 'done', 'failed', 'cancelled', 'interrupted'];

/**
 * Bring `db` up to the current schema version, one migration per transaction.
 * @param {DatabaseSync} db
 * @returns {number} the resulting schema version
 */
export function migrate(db) {
    for (;;) {
        if (schemaVersion(db) >= MIGRATIONS.length) return MIGRATIONS.length;
        // BEGIN IMMEDIATE takes the write lock up front and the version is re-read *inside* it:
        // with a deferred BEGIN and the version read outside, two processes opening the same fresh
        // database both see 0, both begin, and the loser dies on "table taxa already exists".
        db.exec('BEGIN IMMEDIATE');
        try {
            const v = schemaVersion(db);
            if (v >= MIGRATIONS.length) {
                db.exec('ROLLBACK'); // another process migrated while we waited for the lock
                return MIGRATIONS.length;
            }
            MIGRATIONS[v](db);
            db.exec(`PRAGMA user_version = ${v + 1}`); // index-derived, never user input
            db.exec('COMMIT');
        } catch (err) {
            db.exec('ROLLBACK');
            throw err;
        }
    }
}

/** @param {DatabaseSync} db */
function schemaVersion(db) {
    return Number(db.prepare('PRAGMA user_version').get().user_version);
}

/** ISO timestamp `days` in the past. ISO-8601 UTC strings sort chronologically, so `>` works. */
function cutoff(days) {
    return new Date(Date.now() - days * 86_400_000).toISOString();
}

/** The current UTC hour as request_log's key, e.g. '2026-08-22T14'. */
function currentHourBucket() {
    return new Date().toISOString().slice(0, 13);
}

const placeholders = (arr) => arr.map(() => '?').join(',');

/**
 * @typedef {{ id: number, qid: string, kind: string, status: string, wdUri: string, inatTaxonId: string|null, taxonName: string|null, iucn: string|null, wikitext: string|null, payload: any }} FindingRow
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

    // Skipping never asked Wikidata anything, so it must not stamp verified_at — that column
    // means "when we last looked upstream", and a skip is a decision, not an observation.
    const stmtSkipFinding = db.prepare(`
        UPDATE findings SET status = 'skipped', resolved_at = ?, resolution = ?
        WHERE qid = ? AND kind = ?`);

    // The write endpoints address a finding by id, and markVerified is keyed on (qid, kind) and
    // silently updates zero rows for an unknown key — so without this an unknown id would look
    // like a successful confirm.
    const stmtFindingById = db.prepare(
        'SELECT id, qid, kind, status, payload FROM findings WHERE id = ?');

    const stmtHasTaxon = db.prepare('SELECT 1 AS ok FROM taxa WHERE qid = ?');

    // LIMIT -1 means unlimited, so one statement serves both the paged API and the whole-backlog
    // reports. The tiebreak is f.id, not f.qid: qid is TEXT, so 'Q9' sorts after 'Q10' and paging
    // over it would be unstable whenever discovered_at ties, which it does within a batch.
    const stmtList = db.prepare(`
        SELECT f.id, f.qid, f.kind, f.status, t.inat_id, t.taxon_name, t.iucn, f.payload
        FROM findings f
        JOIN taxa t ON t.qid = f.qid
        WHERE f.kind = ? AND f.status = ?
        ORDER BY f.discovered_at, f.id
        LIMIT ? OFFSET ?`);

    const stmtCount = db.prepare(
        'SELECT COUNT(*) AS n FROM findings WHERE kind = ? AND status = ?');

    const stmtCounts = db.prepare(
        'SELECT status, COUNT(*) AS n FROM findings WHERE kind = ? GROUP BY status');

    // Unfinished runs (a crash, or a run still going) leave finished_at NULL and must not be
    // mistaken for the freshness of the data.
    const stmtLatestRun = db.prepare(
        'SELECT MAX(finished_at) AS at FROM runs WHERE finished_at IS NOT NULL');

    // Uploads. dest_file is the natural key: it is what the app computes for a photo and what
    // Commons is asked to name the file, and it is all the legacy localStorage list ever held.
    const stmtUpsertUpload = db.prepare(`
        INSERT INTO uploads (dest_file, qid, photo_id, taxon_name, is_p18, created_at)
        VALUES (?, ?, ?, ?, 0, ?)
        ON CONFLICT(dest_file) DO UPDATE SET
            qid        = COALESCE(excluded.qid, qid),
            photo_id   = COALESCE(excluded.photo_id, photo_id),
            taxon_name = COALESCE(excluded.taxon_name, taxon_name)`);

    const stmtDeleteUpload = db.prepare('DELETE FROM uploads WHERE dest_file = ?');
    const stmtClearPick = db.prepare('UPDATE uploads SET is_p18 = 0 WHERE qid = ?');
    const stmtSetPick = db.prepare('UPDATE uploads SET is_p18 = 1 WHERE dest_file = ?');
    const stmtListUploads = db.prepare(
        'SELECT dest_file, qid, photo_id, taxon_name, is_p18, created_at FROM uploads ORDER BY id');
    // A pick carries its finding id and a taxon name, so the app never has to derive either from
    // whatever rows it happens to have rendered. It did, and paging the worklist would have made
    // "Confirm pending" silently skip every pick that was not on the visible page.
    //
    // `kind = 'image'` because a P18 pick is a statement about the image finding by definition;
    // uploads has no kind of its own. findings is UNIQUE(qid, kind), so this matches at most once.
    // Both joins are LEFT: a pick whose finding has since been skipped or confirmed away must
    // still be listed, or it becomes invisible without ever being withdrawn.
    const stmtPicks = db.prepare(`
        SELECT u.qid, u.dest_file,
               COALESCE(u.taxon_name, t.taxon_name) AS taxon_name,
               f.id AS finding_id
        FROM uploads u
        LEFT JOIN taxa t     ON t.qid = u.qid
        LEFT JOIN findings f ON f.qid = u.qid AND f.kind = 'image'
        WHERE u.is_p18 = 1 AND u.qid IS NOT NULL`);

    const stmtStartRun = db.prepare(
        'INSERT INTO runs (tool, scope, started_at, triggered_by) VALUES (?, ?, ?, ?)');
    const stmtFinishRun = db.prepare(`
        UPDATE runs SET finished_at = ?, n_scanned = ?, n_found = ?, state = ?, error = ?
        WHERE id = ?`);
    const stmtReconcile = db.prepare(`
        UPDATE runs SET state = 'interrupted', finished_at = COALESCE(finished_at, ?)
        WHERE state = 'running'`);
    const runColumns =
        'id, tool, scope, state, error, started_at, finished_at, n_scanned, n_found, triggered_by';
    const stmtLatestRunAny = db.prepare(
        `SELECT ${runColumns} FROM runs ORDER BY id DESC LIMIT 1`);
    const stmtLatestRunByTool = db.prepare(
        `SELECT ${runColumns} FROM runs WHERE tool = ? ORDER BY id DESC LIMIT 1`);
    const stmtLatestRunByToolAndTrigger = db.prepare(
        `SELECT ${runColumns} FROM runs WHERE tool = ? AND triggered_by = ? ORDER BY id DESC LIMIT 1`);

    // One row per UTC hour, upserted on every request the server chooses to log. Bounded forever
    // by pruneRequestLog() rather than needing a separate retention job.
    const stmtRecordRequest = db.prepare(`
        INSERT INTO request_log (hour_bucket, count) VALUES (?, 1)
        ON CONFLICT(hour_bucket) DO UPDATE SET count = count + 1`);
    const stmtHourAverages = db.prepare(`
        SELECT CAST(substr(hour_bucket, 12, 2) AS INTEGER) AS hour, AVG(count) AS avg_count
        FROM request_log WHERE hour_bucket >= ? GROUP BY hour`);
    const stmtSampleDays = db.prepare(`
        SELECT COUNT(DISTINCT substr(hour_bucket, 1, 10)) AS n
        FROM request_log WHERE hour_bucket >= ?`);
    const stmtPruneRequestLog = db.prepare('DELETE FROM request_log WHERE hour_bucket < ?');

    /**
     * @param {{kind: string, status?: string, limit?: number|null, offset?: number}} q
     * @returns {FindingRow[]}
     */
    const listFindings = ({ kind, status = 'open', limit = null, offset = 0 }) =>
        stmtList.all(kind, status, limit ?? -1, offset).map(r => ({
            id: Number(r.id),
            qid: r.qid,
            kind: r.kind,
            status: r.status,
            wdUri: `http://www.wikidata.org/entity/${r.qid}`,
            inatTaxonId: r.inat_id ?? null,
            taxonName: r.taxon_name ?? null,
            iucn: r.iucn ?? null,
            // wikitext is an image-shaped convenience projection kept for existing callers;
            // payload is the raw parsed JSON for every other kind's own shape (links, and later
            // names) to read directly rather than each growing its own projected field here.
            wikitext: r.payload ? JSON.parse(r.payload).wikitext ?? null : null,
            payload: r.payload ? JSON.parse(r.payload) : null,
        }));

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
         * Mark a finding as deliberately passed over. `skipped` is sticky, so discovery never
         * resurfaces it.
         * @param {string} qid @param {string} kind @param {string} [reason]
         */
        markSkipped(qid, kind, reason) {
            stmtSkipFinding.run(
                new Date().toISOString(), JSON.stringify({ reason: reason ?? null }), qid, kind);
        },

        /**
         * One finding by its id, or undefined. The write endpoints address findings by id, while
         * every write statement is keyed on (qid, kind) — this is the translation, and the only
         * way to tell an unknown id from a successful no-op. Carries the raw parsed payload too,
         * for writes that need to read it before deciding anything (picking an ambiguous
         * candidate needs to know the candidate list; nothing before this needed more than the key).
         * @param {number} id
         * @returns {{id: number, qid: string, kind: string, status: string, payload: any}|undefined}
         */
        getFinding(id) {
            const r = stmtFindingById.get(id);
            return r ? {
                id: Number(r.id), qid: r.qid, kind: r.kind, status: r.status,
                payload: r.payload ? JSON.parse(r.payload) : null,
            } : undefined;
        },

        /**
         * Findings of one kind in one status, oldest first. `limit` is deliberately unbounded by
         * default: the HTML report renders the *whole* backlog off this, so a default page size
         * here would silently truncate it. Callers that serve HTTP cap it themselves.
         */
        listFindings,

        /** How many findings match, before paging. @param {{kind: string, status?: string}} q */
        countFindings({ kind, status = 'open' }) {
            return Number(stmtCount.get(kind, status).n);
        },

        /**
         * The whole open backlog for a kind — every run's findings, not just the last one.
         * @param {string} kind
         * @returns {FindingRow[]}
         */
        openFindings(kind) {
            return listFindings({ kind, status: 'open' });
        },

        /** When the data was last touched by a completed run, or null if none has finished. */
        latestRunAt() {
            return stmtLatestRun.get().at ?? null;
        },

        /** @param {string} kind @returns {Record<string, number>} status → count */
        statusCounts(kind) {
            return Object.fromEntries(stmtCounts.all(kind).map(r => [r.status, Number(r.n)]));
        },

        /**
         * Is this taxon known here? `uploads.qid` is a foreign key, so an import carrying a qid
         * from a backlog this database never had must drop the reference rather than fail.
         * @param {string} qid
         */
        hasTaxon(qid) {
            return stmtHasTaxon.get(qid) !== undefined;
        },

        /**
         * Record that a file was (or is claimed to have been) uploaded to Commons. Nothing here is
         * verified against Commons — the app only ever pre-fills the upload form, so this is the
         * user's own claim, and stays one until the app performs the upload itself.
         * @param {{destFile: string, qid?: string|null, photoId?: string|null, taxonName?: string|null}} u
         */
        recordUpload(u) {
            stmtUpsertUpload.run(
                u.destFile, u.qid ?? null, u.photoId ?? null, u.taxonName ?? null,
                new Date().toISOString());
        },

        /** @param {string} destFile */
        removeUpload(destFile) {
            stmtDeleteUpload.run(destFile);
        },

        /**
         * Choose this taxon's pending Wikidata image. The unique partial index allows one pick per
         * taxon, so the previous one is cleared first rather than colliding.
         * @param {string} qid @param {string} destFile
         */
        setP18Pick(qid, destFile) {
            stmtClearPick.run(qid);
            stmtSetPick.run(destFile);
        },

        /** @param {string} qid */
        clearP18Pick(qid) {
            stmtClearPick.run(qid);
        },

        listUploads() {
            return stmtListUploads.all().map(r => ({
                destFile: r.dest_file,
                qid: r.qid ?? null,
                photoId: r.photo_id ?? null,
                taxonName: r.taxon_name ?? null,
                isP18: r.is_p18 === 1,
                createdAt: r.created_at,
            }));
        },

        /** @returns {Record<string, {destFile: string, taxonName: string|null}>} qid → pick */
        p18Picks() {
            return Object.fromEntries(stmtPicks.all().map(r => [r.qid, {
                destFile: r.dest_file,
                taxonName: r.taxon_name ?? null,
                findingId: r.finding_id == null ? null : Number(r.finding_id),
            }]));
        },

        /**
         * @param {string} tool @param {unknown} scope
         * @param {string} [triggeredBy] 'manual' (default) or 'schedule'
         * @returns {number} run id
         */
        startRun(tool, scope, triggeredBy = 'manual') {
            const info = stmtStartRun.run(
                tool, scope === undefined ? null : JSON.stringify(scope),
                new Date().toISOString(), triggeredBy);
            return Number(info.lastInsertRowid);
        },

        /**
         * @param {number} id
         * @param {{scanned: number, found: number, state?: string, error?: string|null}} counts
         */
        finishRun(id, counts) {
            stmtFinishRun.run(
                new Date().toISOString(), counts.scanned, counts.found,
                counts.state ?? 'done', counts.error ?? null, id);
        },

        /**
         * Mark runs still claiming to be in progress as interrupted. Called at startup: nothing
         * survives a process restart, so a `running` row found then died without saying so.
         * @returns {number} how many were reconciled
         */
        reconcileRuns() {
            return Number(stmtReconcile.run(new Date().toISOString()).changes);
        },

        /**
         * The most recent run, whatever became of it.
         * @param {string} [tool]
         * @param {{triggeredBy?: string}} [opts] filter to only 'manual' or 'schedule' runs —
         *   the scheduler uses this to ask "when did a *scheduled* run last start?" separately
         *   from "what's the latest run at all?"
         */
        latestRun(tool, { triggeredBy } = {}) {
            const r = !tool ? stmtLatestRunAny.get()
                : triggeredBy ? stmtLatestRunByToolAndTrigger.get(tool, triggeredBy)
                : stmtLatestRunByTool.get(tool);
            if (!r) return null;
            return {
                id: Number(r.id),
                tool: r.tool,
                scope: r.scope ? JSON.parse(r.scope) : null,
                state: r.state,
                error: r.error ?? null,
                startedAt: r.started_at,
                finishedAt: r.finished_at ?? null,
                scanned: r.n_scanned ?? null,
                found: r.n_found ?? null,
                triggeredBy: r.triggered_by,
            };
        },

        /**
         * Log one request against its UTC hour bucket, for the scheduler's quiet-hours signal.
         * @param {string} [hourBucket] defaults to the current hour, e.g. '2026-08-22T14'
         */
        recordRequest(hourBucket = currentHourBucket()) {
            stmtRecordRequest.run(hourBucket);
        },

        /**
         * The `quietHoursCount` UTC hours-of-day with the lowest average request count over the
         * last `lookbackDays`. Hours with no data at all count as zero (the bootstrap case) — the
         * caller decides whether `sampleDays` is high enough to trust the result.
         * @param {{lookbackDays: number, quietHoursCount: number}} q
         * @returns {{hours: number[], sampleDays: number}}
         */
        quietHoursOfDay({ lookbackDays, quietHoursCount }) {
            const since = cutoff(lookbackDays).slice(0, 13);
            const averages = new Map(
                stmtHourAverages.all(since).map(r => [Number(r.hour), r.avg_count]));
            const sampleDays = Number(stmtSampleDays.get(since).n);
            const ranked = Array.from({ length: 24 }, (_, hour) => ({ hour, avg: averages.get(hour) ?? 0 }))
                .sort((a, b) => a.avg - b.avg || a.hour - b.hour);
            const hours = ranked.slice(0, quietHoursCount).map(r => r.hour).sort((a, b) => a - b);
            return { hours, sampleDays };
        },

        /**
         * Delete hour buckets older than `retentionDays`, keeping request_log bounded forever.
         * @param {number} retentionDays
         * @returns {number} rows deleted
         */
        pruneRequestLog(retentionDays) {
            return Number(stmtPruneRequestLog.run(cutoff(retentionDays).slice(0, 13)).changes);
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
    // busy_timeout first: switching to WAL needs a brief exclusive lock, so with no timeout in
    // effect this line fails outright with SQLITE_BUSY whenever another process is mid-write.
    db.exec('PRAGMA busy_timeout = 5000');
    db.exec('PRAGMA journal_mode = WAL');
    db.exec('PRAGMA foreign_keys = ON');
    db.exec('PRAGMA synchronous = NORMAL');
    migrate(db);
    return createFindingsStore(db);
}
