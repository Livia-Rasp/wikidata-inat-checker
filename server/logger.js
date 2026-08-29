// @ts-check
// Structured server logging: NDJSON to stdout *and* to a daily-rotated file under logs/, shared
// credential redaction, and a timed() helper for step-level tracing. Ported from the sibling
// project vue-commons-gallery's backend/logger.js, adapted to this repo's ESM/no-build-step
// convention (see docs/logging.md).
import path from 'node:path';
import pino from 'pino';
import { LOGS_DIR } from '../lib/paths.js';

/**
 * Paths this app has never logged, kept redacted anyway — the sibling project leaked a foreign
 * localhost cookie into its own logs by adding a header serialiser later, and this process will
 * hold OAuth tokens once slice 9's OAuth work happens.
 */
export const REDACTED_PATHS = [
    'req.headers.cookie',
    'req.headers.authorization',
    'res.headers["set-cookie"]',
];

/**
 * Default `log` for every lib/ function that takes one — importing this module must never have a
 * filesystem side effect, so nothing here touches disk until createLogger() actually runs
 * (server/index.js, once, at startup).
 * @type {{trace: Function, debug: Function, info: Function, warn: Function, error: Function,
 *         fatal: Function, child: () => any}}
 */
export const noopLogger = {
    trace() {}, debug() {}, info() {}, warn() {}, error() {}, fatal() {},
    child() { return noopLogger; },
};

/**
 * Builds the real server logger: one target writes NDJSON to stdout (so `docker compose logs`
 * keeps working unchanged), the other writes the same lines to a daily-rotated file under
 * `logsDir` (so an external reader — the MCP server — has something durable to read, since
 * Docker's own `json-file` driver caps at compose.yaml's 10m/3-file rotation).
 *
 * `dateFormat` and `limit.removeOtherLogFiles: true` must both be set for retention to actually
 * prune old files across restarts — pino-roll only recognises files as its own rotation series
 * when the date is in the filename, and won't clean up ones it doesn't recognise.
 * @param {{ level?: string, retentionDays?: number, logsDir?: string }} [opts]
 */
export function createLogger({
    level = process.env.LOG_LEVEL || 'info',
    retentionDays = Number(process.env.LOG_RETENTION_DAYS) || 7,
    logsDir = LOGS_DIR,
} = {}) {
    const transport = pino.transport({
        targets: [
            { target: 'pino/file', options: { destination: 1 }, level },
            {
                target: 'pino-roll',
                options: {
                    file: path.join(logsDir, 'app'),
                    frequency: 'daily',
                    dateFormat: 'yyyy-MM-dd',
                    size: '20m',
                    mkdir: true,
                    symlink: true,
                    limit: { count: Math.max(retentionDays - 1, 0), removeOtherLogFiles: true },
                },
                level,
            },
        ],
    });
    return pino({ level, redact: REDACTED_PATHS }, transport);
}

/**
 * Wraps an async (or sync) step, logging `{label, durationMs}` at info on success or at error
 * (with `err` attached) on failure, then rethrows — the step gets its own log line rather than a
 * second copy of whatever error handling already logs it again further up.
 * @template T
 * @param {{info: Function, error: Function}} log
 * @param {string} label
 * @param {() => T | Promise<T>} fn
 * @returns {Promise<T>}
 */
export async function timed(log, label, fn) {
    const start = Date.now();
    try {
        const result = await fn();
        log.info({ label, durationMs: Date.now() - start }, label);
        return result;
    } catch (err) {
        log.error({ label, durationMs: Date.now() - start, err }, label);
        throw err;
    }
}
