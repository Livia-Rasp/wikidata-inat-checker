// @ts-check
import fs from 'fs';
import path from 'path';

// Where the tools write. Two kinds of artifact, kept apart on purpose:
//   output/ — deliverables you act on (HTML reports, QuickStatements, JSON exports)
//   cache/  — cross-run caches that let re-runs skip already-checked taxa; NOT deliverables
// Both are gitignored and safe to delete: clearing output/ regenerates the reports, while the
// caches survive so the next run doesn't re-scan everything. (The large iNat taxa SQLite index
// lives separately under ~/.cache/wikidata-inat-checker/.) Paths are relative to the working
// directory — the repo root, where the tools are run.
export const OUTPUT_DIR = 'output';
export const CACHE_DIR = 'cache';

/** Path to `name` inside the output dir (deliverables). */
export function outputPath(name) { return path.join(OUTPUT_DIR, name); }

/** Path to `name` inside the cache dir (cross-run caches). */
export function cachePath(name) { return path.join(CACHE_DIR, name); }

/** Ensure the parent directory of `file` exists (recursive, idempotent); returns `file`. */
export function ensureParentDir(file) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    return file;
}
