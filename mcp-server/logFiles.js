// @ts-check
import { lstat, readdir } from 'node:fs/promises';
import path from 'node:path';

/** `app.2026-08-29.1.log` — what pino-roll writes (server/logger.js's `dateFormat`). */
const DATED = /^app\.(\d{4}-\d{2}-\d{2})\.(\d+)\.log$/;

/** `app.1.log` — the naming pino-roll would fall back to without `dateFormat`. Not expected to
 *  exist here (this app's logger has always set it), but handled the same way the sibling
 *  project's reader does: a single one of these could hold lines from several different days. */
const LEGACY = /^app\.(\d+)\.log$/;

/**
 * Timezone insurance for date-based pruning. pino-roll names a file from *local* midnight, so the
 * day a name refers to depends on the writer's timezone — and the writer is a container (UTC)
 * while a local dev run is not. Rather than model that, every day-window is widened by a full day
 * at both ends: pruning stays a cheap optimisation that can only ever skip a file whose contents
 * provably cannot match, never a correctness-critical decision.
 */
const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Every log file in `dir`, oldest first.
 *
 * `current.log` is deliberately excluded: it is pino-roll's symlink to the active file, so
 * reading it as well as its target would double-count every line written today. Anything else
 * that doesn't match the two naming patterns is ignored rather than guessed at.
 * @param {string} dir
 * @returns {Promise<import('./types.js').LogFile[]>}
 */
export async function listLogFiles(dir) {
    const entries = await readdir(dir);
    const files = [];

    for (const name of entries) {
        const dated = DATED.exec(name);
        const legacy = dated ? null : LEGACY.exec(name);
        if (!dated && !legacy) continue;

        const full = path.join(dir, name);
        // lstat, not stat: a symlink is reported as a symlink and dropped here rather than
        // followed, so the current.log case cannot come back through some future rename of it.
        const info = await lstat(full).catch(() => null);
        if (!info?.isFile()) continue;

        files.push({
            name,
            path: full,
            date: dated ? dated[1] : null,
            index: Number((dated ? dated[2] : legacy?.[1]) ?? 0),
            sizeBytes: info.size,
            mtimeMs: info.mtimeMs,
        });
    }

    return files.sort(compareFiles);
}

/** Oldest first: by date when both have one, then by rotation index. Undated legacy files sort by
 *  mtime, which is the only ordering evidence they carry. */
function compareFiles(a, b) {
    if (a.date && b.date && a.date !== b.date) return a.date < b.date ? -1 : 1;
    if (a.date && !b.date) return a.mtimeMs - b.mtimeMs;
    if (!a.date && b.date) return a.mtimeMs - b.mtimeMs;
    if (!a.date && !b.date) return a.mtimeMs - b.mtimeMs || a.index - b.index;
    return a.index - b.index;
}

/**
 * The subset of `files` that could hold a line inside [since, until].
 *
 * This is what makes a "last 24 hours" question cheap once there are days of logs: a dated file
 * whose whole day falls outside the window is skipped without being opened. Two conservative
 * rules keep that safe: the day window is widened by `DAY_MS` at both ends (see above), and a
 * file is only excluded by mtime when its *last* write predates the range, which no line inside
 * it can contradict.
 * @param {import('./types.js').LogFile[]} files
 * @param {{ since?: number, until?: number }} [range]
 * @returns {import('./types.js').LogFile[]}
 */
export function selectLogFiles(files, range = {}) {
    const { since, until } = range;

    return files.filter((file) => {
        if (since !== undefined && file.mtimeMs < since - DAY_MS) return false;
        if (!file.date) return true;

        const dayStart = Date.parse(`${file.date}T00:00:00Z`);
        if (Number.isNaN(dayStart)) return true;
        const dayEnd = dayStart + DAY_MS;

        if (since !== undefined && dayEnd + DAY_MS < since) return false;
        if (until !== undefined && dayStart - DAY_MS > until) return false;
        return true;
    });
}
