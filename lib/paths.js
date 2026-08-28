// @ts-check
import fs from 'fs';
import path from 'path';

// Where the tools write. Five kinds of artifact, kept apart on purpose:
//   output/  — deliverables you act on (HTML reports, QuickStatements, JSON exports)
//   cache/   — cross-run caches that let re-runs skip already-checked taxa; NOT deliverables
//   data/    — the findings database: durable state that CANNOT be regenerated
//   backups/ — VACUUM INTO snapshots of data/, for when data/ itself is lost or corrupted
//   logs/    — rotated NDJSON server logs; disposable, like output/ and cache/
// output/, cache/ and logs/ are all safe to delete: clearing them regenerates as the tools run
// again. **data/ is not** — it holds the accumulated backlog and which findings have been
// resolved, which no re-run can reconstruct. backups/ exists *because* data/ isn't safe to
// delete; deleting backups/ itself only costs you the snapshots, never the live database. All
// five are gitignored. (The large iNat taxa SQLite index lives separately under
// ~/.cache/wikidata-inat-checker/; it is derived and gets dropped and rebuilt, so it must never
// be confused with data/.) Paths are relative to the working directory — the repo root, where the
// tools are run.
export const OUTPUT_DIR = 'output';
export const CACHE_DIR = 'cache';
export const DATA_DIR = 'data';
export const BACKUP_DIR = 'backups';
export const LOGS_DIR = 'logs';

/** Path to `name` inside the output dir (deliverables). */
export function outputPath(name) { return path.join(OUTPUT_DIR, name); }

/** Path to `name` inside the cache dir (cross-run caches). */
export function cachePath(name) { return path.join(CACHE_DIR, name); }

/** Path to `name` inside the data dir (durable state — not safe to delete). */
export function dataPath(name) { return path.join(DATA_DIR, name); }

/** Path to `name` inside the backups dir (VACUUM INTO snapshots of data/). */
export function backupPath(name) { return path.join(BACKUP_DIR, name); }

/** Path to `name` inside the logs dir (rotated NDJSON server logs). */
export function logPath(name) { return path.join(LOGS_DIR, name); }

/**
 * Where the findings database lives, for every process that opens it.
 *
 * `FINDINGS_DB` used to be honoured by the server alone, so pointing a checker at another database
 * looked like it worked and silently wrote to `data/findings.db` instead — the one file here that
 * cannot be regenerated. One definition, so the CLI and the server can never disagree about which
 * database they are working on, and so a container can mount its volume anywhere.
 */
export function findingsDbPath() {
    return process.env.FINDINGS_DB || dataPath('findings.db');
}

/** Ensure the parent directory of `file` exists (recursive, idempotent); returns `file`. */
export function ensureParentDir(file) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    return file;
}
