// @ts-check
import { createReadStream } from 'node:fs';
import readline from 'node:readline';

/** pino numeric levels, for turning 30 into "info" on the way out. */
const LEVEL_NAMES = { 10: 'trace', 20: 'debug', 30: 'info', 40: 'warn', 50: 'error', 60: 'fatal' };

/**
 * Top-level keys the projection below handles itself or deliberately drops. `req`/`res` are
 * dropped whole and re-added as a few named fields — Fastify's default serialiser logs no headers
 * today (server/app.js), but re-adding a fixed field set rather than passing `req`/`res` through
 * means a reader here can't undo that the moment a header serialiser is added later. `pid`/
 * `hostname` are container noise. Everything not listed here survives, which is how a future
 * business-context field reaches the caller without this file having to know its name.
 */
const HANDLED_KEYS = new Set(['level', 'time', 'msg', 'reqId', 'req', 'res', 'pid', 'hostname', 'err']);

/**
 * Does this line satisfy every constraint in `filter`?
 * @param {import('./types.js').LogLine} line
 * @param {string} raw
 * @param {import('./types.js').LineFilter} filter
 * @returns {boolean}
 */
export function matches(line, raw, filter) {
    if (filter.since !== undefined && line.time < filter.since) return false;
    if (filter.until !== undefined && line.time > filter.until) return false;
    if (filter.minLevel !== undefined && line.level < filter.minLevel) return false;
    if (filter.requestId !== undefined && line.reqId !== filter.requestId) return false;

    if (filter.url !== undefined) {
        const url = line.req?.url;
        if (!url || !url.toLowerCase().includes(filter.url.toLowerCase())) return false;
    }

    if (filter.minResponseTime !== undefined) {
        if (typeof line.responseTime !== 'number') return false;
        if (line.responseTime < filter.minResponseTime) return false;
    }

    if (filter.minStatus !== undefined) {
        const status = line.res?.statusCode;
        if (typeof status !== 'number' || status < filter.minStatus) return false;
    }

    if (filter.errors !== undefined) {
        const status = line.res?.statusCode;
        const threshold = filter.errors === 'any' ? 400 : 500;
        const failed = typeof status === 'number' && status >= threshold;
        if (line.level < 50 && !failed) return false;
    }

    if (filter.contains !== undefined) {
        if (!raw.toLowerCase().includes(filter.contains.toLowerCase())) return false;
    }

    return true;
}

/**
 * A log line reduced to the fields worth putting in an agent's context. Returns a plain object
 * rather than a typed shape on purpose: which extra keys survive differs per line, and naming
 * them here would mean editing this file every time the app logs a new one.
 * @param {import('./types.js').LogLine} line
 * @param {{ stack?: boolean }} [options]
 * @returns {Record<string, unknown>}
 */
export function projectLine(line, options = {}) {
    /** @type {Record<string, unknown>} */
    const out = {
        time: new Date(line.time).toISOString(),
        level: LEVEL_NAMES[line.level] ?? String(line.level),
    };

    if (line.msg !== undefined) out.msg = line.msg;
    if (line.reqId !== undefined) out.requestId = line.reqId;
    if (line.req?.method !== undefined) out.method = line.req.method;
    if (line.req?.url !== undefined) out.url = line.req.url;
    if (line.req?.remoteAddress !== undefined) out.remoteAddress = line.req.remoteAddress;
    if (line.res?.statusCode !== undefined) out.status = line.res.statusCode;

    for (const [key, value] of Object.entries(line)) {
        if (!HANDLED_KEYS.has(key)) out[key] = value;
    }

    if (line.err) {
        out.err = {
            type: line.err.type,
            message: line.err.message,
            ...(options.stack && line.err.stack ? { stack: truncateStack(line.err.stack) } : {}),
        };
    }

    return out;
}

/** Stack traces run to dozens of frames; the top few identify the failure and the rest are node
 *  internals. */
function truncateStack(stack, frames = 8) {
    const lines = stack.split('\n');
    if (lines.length <= frames) return stack;
    return [...lines.slice(0, frames), `    ... ${lines.length - frames} more frames`].join('\n');
}

/**
 * Streams every matching line from `files`, oldest first, updating `stats` as it goes.
 *
 * A generator rather than an array because the aggregate tools need every sample in a range but
 * only keep a number per line — materialising a week of log lines just to average them would be
 * the one way this server could hurt the box it runs on. A log file is capped at 20 MB by
 * pino-roll and there can be a week of them, so nothing here reads a whole file into memory
 * either.
 * @param {import('./types.js').LogFile[]} files
 * @param {import('./types.js').LineFilter} filter
 * @param {import('./types.js').ReadStats} stats
 * @returns {AsyncGenerator<import('./types.js').LogLine>}
 */
export async function* streamLogLines(files, filter, stats) {
    for (const file of files) {
        stats.filesRead += 1;
        const stream = createReadStream(file.path, { encoding: 'utf8' });
        const lines = readline.createInterface({ input: stream, crlfDelay: Infinity });

        try {
            for await (const raw of lines) {
                if (raw.trim() === '') continue;
                stats.linesScanned += 1;

                /** @type {import('./types.js').LogLine} */
                let parsed;
                try {
                    parsed = JSON.parse(raw);
                } catch {
                    stats.malformed += 1;
                    continue;
                }
                if (typeof parsed?.time !== 'number' || typeof parsed?.level !== 'number') {
                    stats.malformed += 1;
                    continue;
                }

                if (!matches(parsed, raw, filter)) continue;
                stats.linesMatched += 1;
                yield parsed;
            }
        } finally {
            lines.close();
            stream.destroy();
        }
    }
}

/** A zeroed ReadStats, so every caller starts from the same shape.
 *  @returns {import('./types.js').ReadStats} */
export function emptyStats() {
    return { filesRead: 0, linesScanned: 0, linesMatched: 0, malformed: 0, truncated: false };
}

/**
 * Reads `files` and returns at most `limit` matching lines, oldest first.
 *
 * `order: "newest"` keeps a sliding window of the most recent matches, which is what makes "the
 * last 20 errors" cheap over a week of logs without sorting anything; `order: "oldest"` keeps the
 * first ones it meets. Either way the returned lines are in chronological order — the order
 * option chooses *which* matches survive, not how they are arranged.
 * @param {import('./types.js').LogFile[]} files
 * @param {import('./types.js').LineFilter} filter
 * @param {{ limit: number, order?: 'oldest' | 'newest' }} options
 * @returns {Promise<{ lines: import('./types.js').LogLine[], stats: import('./types.js').ReadStats }>}
 */
export async function readLogLines(files, filter, options) {
    const order = options.order ?? 'newest';
    /** @type {import('./types.js').LogLine[]} */
    const kept = [];
    const stats = emptyStats();

    for await (const line of streamLogLines(files, filter, stats)) {
        if (order === 'newest') {
            kept.push(line);
            if (kept.length > options.limit) kept.shift();
        } else if (kept.length < options.limit) {
            kept.push(line);
        }
    }

    stats.truncated = stats.linesMatched > kept.length;
    return { lines: kept, stats };
}
