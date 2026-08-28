#!/usr/bin/env node
// @ts-check
// VACUUM INTO a timestamped snapshot of the findings database — `npm run backup`.
//
// Meant to run on a timer (a host crontab entry once this is actually deployed — see
// docs/container.md), not inside the container: the container's root filesystem is read-only and
// has no cron, and the CLI already talks to data/findings.db directly on the host, so a backup is
// the same two-process-one-file shape openFindingsDb was written for, not a new one.
//
// data/findings.db is the one artifact in this repo that cannot be regenerated (see lib/paths.js);
// everything else here is disposable and safe to delete, backups/ included — losing it costs you
// snapshots, never the live database.
import { existsSync, mkdirSync, readdirSync, unlinkSync } from 'node:fs';
import { openFindingsDb } from '../lib/db.js';
import { findingsDbPath, backupPath, BACKUP_DIR } from '../lib/paths.js';
import { parseArgs, parseLimit } from '../lib/utils.js';

const args = parseArgs();
const KEEP = parseLimit(/** @type {any} */ ({ limit: args.keep }), 14);

/** Sortable and filename-safe: no colons, no dots but the extension's own. */
function timestamp() {
    return new Date().toISOString().replace(/[:.]/g, '-');
}

/** Delete the oldest backups beyond `keep`. Filenames sort chronologically because the timestamp
 *  in them does, so no stat() per file is needed. */
function prune(keep) {
    const files = readdirSync(BACKUP_DIR).filter((f) => /^findings-.*\.db$/.test(f)).sort();
    const stale = files.slice(0, Math.max(0, files.length - keep));
    for (const f of stale) unlinkSync(backupPath(f));
    return stale;
}

function main() {
    if (!existsSync(BACKUP_DIR)) mkdirSync(BACKUP_DIR, { recursive: true });

    const dest = backupPath(`findings-${timestamp()}.db`);
    const store = openFindingsDb(findingsDbPath());
    try {
        store.vacuumInto(dest);
    } finally {
        store.close();
    }

    const removed = prune(KEEP);
    console.log(`Backed up ${findingsDbPath()} -> ${dest}`);
    if (removed.length) console.log(`Pruned ${removed.length} backup(s) beyond the last ${KEEP}: ${removed.join(', ')}`);
}

main();
