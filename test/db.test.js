// @ts-check
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { createFindingsStore, migrate, DEFAULT_RECHECK_DAYS } from '../lib/db.js';

// A migrated in-memory findings DB, so the real schema and queries are exercised without a file.
function makeStore() {
    const db = new DatabaseSync(':memory:');
    migrate(db);
    return { db, store: createFindingsStore(db) };
}

/** Backdate a finding's checked_at by `days`, to test negative-result expiry without sleeping. */
function backdate(db, qid, days) {
    const when = new Date(Date.now() - days * 86_400_000).toISOString();
    db.prepare('UPDATE findings SET checked_at = ? WHERE qid = ?').run(when, qid);
}

function seed(store, qid, status, payload) {
    store.upsertTaxon({ qid, inatId: `inat-${qid}`, taxonName: `Taxon ${qid}`, iucn: 'VU' });
    store.recordFinding({ qid, kind: 'image', status, payload });
}

test('migrate creates the current schema and is idempotent', () => {
    const db = new DatabaseSync(':memory:');
    const version = migrate(db);
    assert.equal(Number(db.prepare('PRAGMA user_version').get().user_version), version);
    assert.equal(migrate(db), version, 're-running must not throw or bump the version');

    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(r => r.name);
    for (const t of ['taxa', 'findings', 'runs', 'uploads', 'request_log']) {
        assert.ok(tables.includes(t), `${t} table exists`);
    }
});

test('the v2 migration runs on an existing v1 database without touching its rows', () => {
    // The upgrade path a real installation takes: a populated v1 file, opened by newer code.
    const db = new DatabaseSync(':memory:');
    db.exec(`
        CREATE TABLE taxa (qid TEXT PRIMARY KEY, inat_id TEXT, taxon_name TEXT, rank TEXT, iucn TEXT, first_seen TEXT NOT NULL) STRICT;
        CREATE TABLE findings (id INTEGER PRIMARY KEY, qid TEXT NOT NULL REFERENCES taxa(qid), kind TEXT NOT NULL, payload TEXT, status TEXT NOT NULL, discovered_at TEXT NOT NULL, checked_at TEXT NOT NULL, verified_at TEXT, resolved_at TEXT, resolution TEXT, UNIQUE (qid, kind)) STRICT;
        CREATE INDEX idx_findings_worklist ON findings(kind, status);
        CREATE TABLE runs (id INTEGER PRIMARY KEY, tool TEXT NOT NULL, scope TEXT, started_at TEXT NOT NULL, finished_at TEXT, n_scanned INTEGER, n_found INTEGER) STRICT;
        PRAGMA user_version = 1;
    `);
    const now = new Date().toISOString();
    db.prepare('INSERT INTO taxa (qid, taxon_name, first_seen) VALUES (?, ?, ?)').run('Q1', 'Taxon Q1', now);
    db.prepare(`INSERT INTO findings (qid, kind, payload, status, discovered_at, checked_at)
                VALUES (?, ?, ?, ?, ?, ?)`)
        .run('Q1', 'image', JSON.stringify({ wikitext: 'precious' }), 'open', now, now);

    assert.ok(migrate(db) >= 2);

    const store = createFindingsStore(db); // only buildable once the schema is current
    assert.equal(store.openFindings('image')[0].wikitext, 'precious', 'existing findings survive');
    assert.deepEqual(store.listUploads(), [], 'and the new table is there and empty');
});

test('a taxon can have only one P18 pick, enforced by the database', () => {
    const { store } = makeStore();
    seed(store, 'Q1', 'open');
    store.recordUpload({ destFile: 'A.jpg', qid: 'Q1', photoId: '1', taxonName: 'Taxon Q1' });
    store.recordUpload({ destFile: 'B.jpg', qid: 'Q1', photoId: '2', taxonName: 'Taxon Q1' });

    store.setP18Pick('Q1', 'A.jpg');
    store.setP18Pick('Q1', 'B.jpg'); // changing your mind must not collide with the unique index

    const picks = store.p18Picks();
    assert.equal(picks.Q1.destFile, 'B.jpg');
    assert.equal(picks.Q1.taxonName, 'Taxon Q1');
    assert.equal(store.listUploads().filter(u => u.isP18).length, 1);
});

test('a pick carries the finding id and name, so no caller has to look them up', () => {
    // The app used to derive both from the rows it had rendered, which made "Confirm pending"
    // silently skip every pick that was not on the visible page once the worklist was paged.
    const { store } = makeStore();
    seed(store, 'Q1', 'open');
    const [finding] = store.openFindings('image');

    store.recordUpload({ destFile: 'A.jpg', qid: 'Q1' }); // no taxonName from the caller
    store.setP18Pick('Q1', 'A.jpg');

    assert.deepEqual(store.p18Picks(), {
        Q1: { destFile: 'A.jpg', taxonName: 'Taxon Q1', findingId: finding.id },
    }, 'the name falls back to the taxa table rather than coming back null');
});

test('a pick outlives the finding it was made against', () => {
    // Skipping or confirming a taxon must not make its pending pick invisible — it would then be
    // impossible to withdraw, and the QuickStatements panel would quietly lose a line.
    const { store } = makeStore();
    seed(store, 'Q1', 'open');
    store.recordUpload({ destFile: 'A.jpg', qid: 'Q1', taxonName: 'Taxon Q1' });
    store.setP18Pick('Q1', 'A.jpg');
    store.markSkipped('Q1', 'image', 'not mine');

    const picks = store.p18Picks();
    assert.equal(picks.Q1.destFile, 'A.jpg');
    assert.ok(picks.Q1.findingId > 0, 'the finding is still addressable');
});

test('uploads round-trip and are removable, and an upsert never blanks known fields', () => {
    const { store } = makeStore();
    seed(store, 'Q1', 'open');
    store.recordUpload({ destFile: 'A.jpg', qid: 'Q1', photoId: '7', taxonName: 'Taxon Q1' });
    store.recordUpload({ destFile: 'A.jpg' }); // a later claim that knows less

    const [row] = store.listUploads();
    assert.equal(row.photoId, '7', 'a null must not overwrite a known photo id');
    assert.equal(row.isP18, false);

    store.removeUpload('A.jpg');
    assert.deepEqual(store.listUploads(), []);
});

test('an upload with no resolvable taxon is still recorded', () => {
    const { store } = makeStore();
    // Imported legacy filenames may not parse back to a taxon; losing them would be worse.
    store.recordUpload({ destFile: 'Something odd.jpg' });
    assert.deepEqual(store.listUploads().map(u => [u.destFile, u.qid]), [['Something odd.jpg', null]]);
    assert.deepEqual(store.p18Picks(), {}, 'and it can never become a pick');
});

test('getFinding translates an id, and says nothing for an unknown one', () => {
    const { store } = makeStore();
    seed(store, 'Q1', 'open');
    const id = store.openFindings('image')[0].id;

    assert.deepEqual(store.getFinding(id), { id, qid: 'Q1', kind: 'image', status: 'open' });
    // The trap: markVerified silently updates zero rows, so without this an unknown id would
    // look like a successful confirm.
    assert.equal(store.getFinding(999_999), undefined);
});

test('markSkipped settles a finding without claiming Wikidata was asked', () => {
    const { db, store } = makeStore();
    seed(store, 'Q1', 'open', { wikitext: 'precious' });

    store.markSkipped('Q1', 'image', 'no Commons category will ever exist');

    const row = db.prepare("SELECT status, verified_at, resolved_at, resolution, payload FROM findings WHERE qid='Q1'").get();
    assert.equal(row.status, 'skipped');
    assert.equal(row.verified_at, null, 'skipping never looked upstream, so it must not claim to have');
    assert.ok(row.resolved_at);
    assert.equal(JSON.parse(row.resolution).reason, 'no Commons category will ever exist');
    assert.equal(JSON.parse(row.payload).wikitext, 'precious', 'the draft survives');
    assert.ok(store.skipQids('image').has('Q1'), 'skipped is sticky — never rediscovered');
});

test('STRICT tables reject a wrong-typed value', () => {
    const { db, store } = makeStore();
    store.upsertTaxon({ qid: 'Q1' });
    // n_scanned is INTEGER; STRICT must refuse a string that is not a number
    assert.throws(
        () => db.prepare('INSERT INTO runs (tool, started_at, n_scanned) VALUES (?, ?, ?)')
            .run('images', new Date().toISOString(), 'not-a-number'),
        /cannot store TEXT value in INTEGER column/i);
});

test('recordFinding upserts on (qid, kind) rather than duplicating', () => {
    const { db, store } = makeStore();
    seed(store, 'Q1', 'no_photos');
    seed(store, 'Q1', 'open', { wikitext: '{{Species|Panthera onca|}}' });

    const rows = db.prepare("SELECT status, discovered_at, checked_at FROM findings WHERE qid = 'Q1'").all();
    assert.equal(rows.length, 1, 'one row per (qid, kind)');
    assert.equal(rows[0].status, 'open', 'status flips in place');
    assert.equal(store.openFindings('image').length, 1);
});

test('skipQids treats negative statuses as skips, not just open', () => {
    const { store } = makeStore();
    seed(store, 'Q1', 'open');
    seed(store, 'Q2', 'no_photos');
    seed(store, 'Q3', 'no_draft');
    seed(store, 'Q4', 'skipped');
    seed(store, 'Q5', 'done');

    const skip = store.skipQids('image');
    // The re-discovery trap: skipping only `open` would resurface everything else on the next
    // top-up, including taxa deliberately passed over.
    assert.deepEqual(skip, new Set(['Q1', 'Q2', 'Q3', 'Q4', 'Q5']));
});

test('a negative finding expires once it is older than the recheck window', () => {
    const { db, store } = makeStore();
    seed(store, 'Q1', 'no_photos');
    backdate(db, 'Q1', DEFAULT_RECHECK_DAYS + 1);

    assert.ok(!store.skipQids('image').has('Q1'), 'stale negative is a candidate again');
    assert.ok(store.skipQids('image', DEFAULT_RECHECK_DAYS + 30).has('Q1'),
        'the same row stays skipped under a wider window');
});

test('a settled finding never expires, however old', () => {
    const { db, store } = makeStore();
    seed(store, 'Q1', 'done');
    seed(store, 'Q2', 'open');
    backdate(db, 'Q1', 3650);
    backdate(db, 'Q2', 3650);

    const skip = store.skipQids('image', 1);
    assert.ok(skip.has('Q1'), 'done is settled — an edit was made, it cannot un-happen');
    assert.ok(skip.has('Q2'), 'open is settled — it is already on the worklist');
});

test('a re-check flips no_photos to open and keeps the original discovered_at', () => {
    const { db, store } = makeStore();
    seed(store, 'Q1', 'no_photos');
    const first = db.prepare("SELECT discovered_at FROM findings WHERE qid = 'Q1'").get().discovered_at;
    backdate(db, 'Q1', DEFAULT_RECHECK_DAYS + 1);
    const stale = db.prepare("SELECT checked_at FROM findings WHERE qid = 'Q1'").get().checked_at;

    seed(store, 'Q1', 'open', { wikitext: '{{Species|Panthera leo|}}' });
    const row = db.prepare("SELECT status, discovered_at, checked_at FROM findings WHERE qid = 'Q1'").get();

    assert.equal(row.status, 'open');
    assert.equal(row.discovered_at, first, 'discovered_at records the first sighting, not the re-check');
    assert.ok(row.checked_at > stale, 'checked_at moves forward on re-check');
    assert.ok(store.skipQids('image', 1).has('Q1'), 'now settled, so no longer expiring');
});

test('openFindings returns only open rows, shaped for the report', () => {
    const { store } = makeStore();
    seed(store, 'Q1', 'open', { wikitext: '{{Species|Panthera onca|}}' });
    seed(store, 'Q2', 'no_photos');
    seed(store, 'Q3', 'done', { wikitext: 'x' });

    const rows = store.openFindings('image');
    assert.equal(rows.length, 1);
    assert.deepEqual(rows[0], {
        id: rows[0].id,
        qid: 'Q1',
        kind: 'image',
        status: 'open',
        wdUri: 'http://www.wikidata.org/entity/Q1',
        inatTaxonId: 'inat-Q1',
        taxonName: 'Taxon Q1',
        iucn: 'VU',
        wikitext: '{{Species|Panthera onca|}}',
    });
    assert.equal(typeof rows[0].id, 'number', 'the row carries the finding id the API addresses');
});

test('listFindings filters by status and kind, and openFindings is the unlimited open case', () => {
    const { store } = makeStore();
    seed(store, 'Q1', 'open', { wikitext: 'a' });
    seed(store, 'Q2', 'done', { wikitext: 'b' });
    store.upsertTaxon({ qid: 'Q3', taxonName: 'Taxon Q3' });
    store.recordFinding({ qid: 'Q3', kind: 'name', status: 'open' });

    assert.deepEqual(store.listFindings({ kind: 'image' }).map(r => r.qid), ['Q1']);
    assert.deepEqual(store.listFindings({ kind: 'image', status: 'done' }).map(r => r.qid), ['Q2']);
    assert.deepEqual(store.listFindings({ kind: 'name' }).map(r => r.qid), ['Q3']);
    // The truncation guard: drafts.html renders everything openFindings returns, so it must
    // never inherit a page size.
    assert.deepEqual(store.openFindings('image'), store.listFindings({ kind: 'image' }));
});

test('listFindings pages stably and countFindings reports the untruncated total', () => {
    const { store } = makeStore();
    for (const qid of ['Q10', 'Q9', 'Q2']) seed(store, qid, 'open', { wikitext: qid });

    const all = store.listFindings({ kind: 'image' }).map(r => r.qid);
    assert.equal(all.length, 3);
    assert.deepEqual(store.listFindings({ kind: 'image', limit: 2 }).map(r => r.qid), all.slice(0, 2));
    assert.deepEqual(store.listFindings({ kind: 'image', limit: 2, offset: 2 }).map(r => r.qid), all.slice(2));
    assert.equal(store.countFindings({ kind: 'image' }), 3, 'the total ignores limit/offset');
    assert.equal(store.countFindings({ kind: 'image', status: 'done' }), 0);
});

test('latestRunAt reports the last finished run, never an unfinished one', () => {
    const { store } = makeStore();
    assert.equal(store.latestRunAt(), null, 'no runs yet');

    const done = store.startRun('images', {});
    store.finishRun(done, { scanned: 1, found: 1 });
    const finishedAt = store.latestRunAt();
    assert.ok(finishedAt, 'a finished run sets the freshness stamp');

    store.startRun('images', {}); // still running, or crashed
    assert.equal(store.latestRunAt(), finishedAt, 'an unfinished run must not look like fresh data');
});

test('upsertTaxon does not blank existing fields with nulls', () => {
    const { store } = makeStore();
    store.upsertTaxon({ qid: 'Q1', inatId: '42', taxonName: 'Panthera onca', iucn: 'NT' });
    store.upsertTaxon({ qid: 'Q1', inatId: '42' }); // a later pass that knows less
    store.recordFinding({ qid: 'Q1', kind: 'image', status: 'open', payload: { wikitext: 'w' } });

    const row = store.openFindings('image')[0];
    assert.equal(row.taxonName, 'Panthera onca', 'a null must not overwrite a known name');
});

test('statusCounts and the runs log record what a run did', () => {
    const { store } = makeStore();
    seed(store, 'Q1', 'open');
    seed(store, 'Q2', 'no_photos');
    seed(store, 'Q3', 'no_photos');

    assert.deepEqual(store.statusCounts('image'), { open: 1, no_photos: 2 });

    const id = store.startRun('images', { iucn: 'CR', limit: 20 });
    store.finishRun(id, { scanned: 3, found: 1 });
    assert.equal(typeof id, 'number');
});

test('a run records how it ended, not just that it stopped', () => {
    const { store } = makeStore();
    const ok = store.startRun('images', { limit: 10 });
    store.finishRun(ok, { scanned: 10, found: 2 });
    assert.equal(store.latestRun('images').state, 'done');

    const bad = store.startRun('images', {});
    store.finishRun(bad, { scanned: 1, found: 0, state: 'failed', error: 'Wikidata HTTP 503' });
    const row = store.latestRun('images');
    assert.equal(row.state, 'failed');
    assert.equal(row.error, 'Wikidata HTTP 503');
    assert.deepEqual(row.scope, {});
});

test('a run left running is reconciled at startup, not left looking alive', () => {
    const { store } = makeStore();
    const orphan = store.startRun('images', {});
    assert.equal(store.latestRun().state, 'running');

    // Nothing survives a process restart, so a `running` row found at boot died without saying so.
    assert.equal(store.reconcileRuns(), 1);
    const row = store.latestRun();
    assert.equal(row.state, 'interrupted');
    assert.ok(row.finishedAt, 'and it stops looking in-progress forever');
    assert.equal(row.id, orphan);

    assert.equal(store.reconcileRuns(), 0, 'reconciling twice changes nothing');
});

test('latestRun is null before anything has run', () => {
    const { store } = makeStore();
    assert.equal(store.latestRun(), null);
    assert.equal(store.latestRun('images'), null);
});

test('the v3 migration classifies the runs that predate it', () => {
    const db = new DatabaseSync(':memory:');
    db.exec(`
        CREATE TABLE runs (id INTEGER PRIMARY KEY, tool TEXT NOT NULL, scope TEXT,
            started_at TEXT NOT NULL, finished_at TEXT, n_scanned INTEGER, n_found INTEGER) STRICT;
        CREATE TABLE taxa (qid TEXT PRIMARY KEY, inat_id TEXT, taxon_name TEXT, rank TEXT, iucn TEXT, first_seen TEXT NOT NULL) STRICT;
        CREATE TABLE findings (id INTEGER PRIMARY KEY, qid TEXT NOT NULL REFERENCES taxa(qid), kind TEXT NOT NULL,
            payload TEXT, status TEXT NOT NULL, discovered_at TEXT NOT NULL, checked_at TEXT NOT NULL,
            verified_at TEXT, resolved_at TEXT, resolution TEXT, UNIQUE (qid, kind)) STRICT;
        CREATE INDEX idx_findings_worklist ON findings(kind, status);
        INSERT INTO runs (tool, scope, started_at, finished_at) VALUES ('images', NULL, '2026-01-01', '2026-01-02');
        INSERT INTO runs (tool, scope, started_at) VALUES ('images', NULL, '2026-01-03');
        PRAGMA user_version = 1;
    `);
    migrate(db);

    const states = db.prepare('SELECT state FROM runs ORDER BY id').all().map(r => r.state);
    assert.deepEqual(states, ['done', 'interrupted'],
        'a finished run is done; one that never finished never will');
});

test('the v4 migration backfills triggered_by and adds an empty request_log', () => {
    // The upgrade path a real installation takes: a populated v3 file, opened by newer code.
    const db = new DatabaseSync(':memory:');
    db.exec(`
        CREATE TABLE taxa (qid TEXT PRIMARY KEY, inat_id TEXT, taxon_name TEXT, rank TEXT, iucn TEXT, first_seen TEXT NOT NULL) STRICT;
        CREATE TABLE findings (id INTEGER PRIMARY KEY, qid TEXT NOT NULL REFERENCES taxa(qid), kind TEXT NOT NULL,
            payload TEXT, status TEXT NOT NULL, discovered_at TEXT NOT NULL, checked_at TEXT NOT NULL,
            verified_at TEXT, resolved_at TEXT, resolution TEXT, UNIQUE (qid, kind)) STRICT;
        CREATE INDEX idx_findings_worklist ON findings(kind, status);
        CREATE TABLE runs (id INTEGER PRIMARY KEY, tool TEXT NOT NULL, scope TEXT,
            started_at TEXT NOT NULL, finished_at TEXT, n_scanned INTEGER, n_found INTEGER,
            state TEXT NOT NULL DEFAULT 'running', error TEXT) STRICT;
        CREATE TABLE uploads (id INTEGER PRIMARY KEY, dest_file TEXT NOT NULL UNIQUE, qid TEXT REFERENCES taxa(qid),
            photo_id TEXT, taxon_name TEXT, is_p18 INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL) STRICT;
        CREATE INDEX idx_uploads_qid ON uploads(qid);
        CREATE UNIQUE INDEX idx_uploads_p18 ON uploads(qid) WHERE is_p18 = 1;
        INSERT INTO runs (tool, scope, started_at, finished_at, state)
            VALUES ('images', NULL, '2026-01-01', '2026-01-02', 'done');
        PRAGMA user_version = 3;
    `);

    migrate(db);

    const run = db.prepare('SELECT triggered_by FROM runs').get();
    assert.equal(run.triggered_by, 'manual', 'a pre-existing run backfills to manual');

    const store = createFindingsStore(db);
    assert.equal(store.quietHoursOfDay({ lookbackDays: 30, quietHoursCount: 6 }).sampleDays, 0,
        'request_log exists and starts empty');
});

test('startRun records who triggered it, and latestRun can filter by it', () => {
    const { store } = makeStore();
    const manualId = store.startRun('images', {});
    store.finishRun(manualId, { scanned: 1, found: 1 });
    assert.equal(store.latestRun('images').triggeredBy, 'manual', 'the default');

    const scheduledId = store.startRun('images', {}, 'schedule');
    store.finishRun(scheduledId, { scanned: 2, found: 2 });
    assert.equal(store.latestRun('images').triggeredBy, 'schedule', 'latest overall is the scheduled one');
    assert.equal(store.latestRun('images', { triggeredBy: 'manual' }).id, manualId,
        'filtering finds the manual run even though it is not the latest');
});

test('recordRequest accumulates per UTC hour bucket', () => {
    const { db, store } = makeStore();
    store.recordRequest('2026-08-22T14');
    store.recordRequest('2026-08-22T14');
    store.recordRequest('2026-08-22T15');

    const rows = db.prepare('SELECT hour_bucket, count FROM request_log ORDER BY hour_bucket').all()
        .map(r => ({ hour_bucket: r.hour_bucket, count: r.count }));
    assert.deepEqual(rows, [
        { hour_bucket: '2026-08-22T14', count: 2 },
        { hour_bucket: '2026-08-22T15', count: 1 },
    ]);
});

test('recordRequest defaults to the current hour when no bucket is given', () => {
    const { db, store } = makeStore();
    store.recordRequest();
    const rows = db.prepare('SELECT hour_bucket FROM request_log').all();
    assert.equal(rows.length, 1);
    assert.equal(rows[0].hour_bucket, new Date().toISOString().slice(0, 13));
});

test('quietHoursOfDay ranks hours by average traffic, with no data treated as zero', () => {
    const { store } = makeStore();
    // Hours 10 and 11 are busy every day in the window; every other hour never appears.
    for (const day of ['2026-08-20', '2026-08-21', '2026-08-22']) {
        store.recordRequest(`${day}T10`);
        store.recordRequest(`${day}T10`);
        store.recordRequest(`${day}T10`);
        store.recordRequest(`${day}T11`);
    }

    const { hours, sampleDays } = store.quietHoursOfDay({ lookbackDays: 30, quietHoursCount: 22 });
    assert.equal(sampleDays, 3, 'three distinct calendar days of history');
    assert.equal(hours.length, 22, 'the 22 hours with no traffic at all');
    assert.ok(!hours.includes(10), 'the busiest hour is excluded');
    assert.ok(!hours.includes(11), 'the second-busiest hour is excluded');
});

test('quietHoursOfDay ignores buckets outside the lookback window', () => {
    const { store } = makeStore();
    store.recordRequest('2020-01-01T05'); // ancient, must not count
    const { sampleDays } = store.quietHoursOfDay({ lookbackDays: 30, quietHoursCount: 6 });
    assert.equal(sampleDays, 0);
});

test('pruneRequestLog deletes only buckets older than the retention window', () => {
    const { db, store } = makeStore();
    store.recordRequest('2020-01-01T05');
    store.recordRequest(); // current hour, must survive

    const deleted = store.pruneRequestLog(60);
    assert.equal(deleted, 1);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM request_log').get().n, 1);
});
