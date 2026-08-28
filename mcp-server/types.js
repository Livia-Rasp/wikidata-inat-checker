// @ts-check
// Shared JSDoc typedefs. No runtime code — imported only for the types.

/**
 * One parsed line of the app's NDJSON log.
 *
 * Only the fields this server actually reasons about are named; everything else a line carries
 * stays reachable through the index signature. Shaped after Fastify's own request logging (not
 * pino-http's, which the sibling vue-commons-gallery project uses) — notably the correlation id
 * is a top-level `reqId`, not `req.id`, and `req` never carries headers (server/app.js redacts at
 * the source, before a serialiser ever runs, so there is nothing here to redact a second time).
 * @typedef {Object} LogLine
 * @property {number} level pino numeric level: 30 info, 40 warn, 50 error, 60 fatal.
 * @property {number} time Epoch milliseconds.
 * @property {string} [msg]
 * @property {string} [reqId] Present on every Fastify request-lifecycle line.
 * @property {{method?: string, url?: string, host?: string, remoteAddress?: string, remotePort?: number}} [req]
 * @property {{statusCode?: number}} [res]
 * @property {number} [responseTime] Milliseconds, on the "request completed" line only.
 * @property {string} [label] timed()'s step name, e.g. "confirmByKind".
 * @property {number} [durationMs] timed()'s measured duration for that step.
 * @property {{type?: string, message?: string, stack?: string}} [err]
 */

/**
 * A log file on disk, as listLogFiles() describes it. `date` is null for the legacy numbered
 * files written before pino-roll's `dateFormat` was configured — those can hold lines from
 * several days at once, so nothing may be concluded about their contents from the name alone.
 * @typedef {Object} LogFile
 * @property {string} name
 * @property {string} path
 * @property {string | null} date
 * @property {number} index
 * @property {number} sizeBytes
 * @property {number} mtimeMs
 */

/**
 * Which lines a read should return. Every field is optional; an empty filter matches everything.
 * Times are epoch milliseconds.
 * @typedef {Object} LineFilter
 * @property {number} [since]
 * @property {number} [until]
 * @property {number} [minLevel] Lowest pino level to include, e.g. 50 for errors and worse.
 * @property {string} [contains] Case-insensitive substring, tested against the whole raw line.
 * @property {string} [requestId] Exact match on `reqId`.
 * @property {string} [url] Case-insensitive substring of `req.url`.
 * @property {number} [minResponseTime] Minimum `responseTime` in ms; also requires the line to have one.
 * @property {number} [minStatus] Minimum `res.statusCode`, e.g. 400 for failures.
 * @property {'server' | 'any'} [errors] A genuine OR, not another AND: a line counts when it is
 *   level >= 50 *or* it reported a failing status. Both halves are load-bearing — a route can
 *   answer 503 with a logged error, but a rate-limited request is only ever a 429 with no error
 *   line at all. "server" counts 5xx; "any" also counts 4xx.
 */

/**
 * What a read scanned, so a caller can tell "nothing matched" from "everything matched and you
 * are seeing a slice".
 * @typedef {Object} ReadStats
 * @property {number} filesRead
 * @property {number} linesScanned
 * @property {number} linesMatched
 * @property {number} malformed Lines that were not valid JSON. Counted rather than thrown on: a
 *   log being appended to while it is read can legitimately yield one torn line.
 * @property {boolean} truncated
 */

export {};
