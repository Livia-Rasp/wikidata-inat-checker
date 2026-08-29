// @ts-check
// Read-only by design. There are no write tools here, no delete, no rotate — this server
// observes the app, it does not operate it. Adding a tool that changes anything is a decision to
// be made explicitly, not a convenience to reach for. The log directory is mounted read-only in
// compose.yaml so that intent is enforced a second time, below this code. See docs/mcp-server.md.
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { listLogFiles, selectLogFiles } from './logFiles.js';
import { emptyStats, projectLine, readLogLines, streamLogLines } from './read.js';
import { LatencyAccumulator } from './stats.js';
import { resolveRange } from './time.js';

/** @param {unknown} value */
const json = (value) => ({ content: [{ type: /** @type {const} */ ('text'), text: JSON.stringify(value, null, 2) }] });

const LEVELS = ['trace', 'debug', 'info', 'warn', 'error', 'fatal'];
const LEVEL_VALUES = { trace: 10, debug: 20, info: 30, warn: 40, error: 50, fatal: 60 };

/** The shared time-window inputs, spelled the same way on every tool. */
const rangeShape = {
    since: z.union([z.string(), z.number()]).optional()
        .describe('Start of the window: a relative age ("24h", "7d", "90m"), an ISO timestamp, or epoch ms. Defaults to 24h.'),
    until: z.union([z.string(), z.number()]).optional()
        .describe('End of the window, same formats. Defaults to now.'),
};

/**
 * @param {string} logDir
 * @param {number} since
 * @param {number} until
 * @returns {Promise<import('./types.js').LogFile[]>}
 */
async function selectFiles(logDir, since, until) {
    return selectLogFiles(await listLogFiles(logDir), { since, until });
}

/** The envelope every tool returns around its results, so a caller can always tell "nothing
 *  matched" from "this is a slice of far more".
 *  @param {import('./types.js').ReadStats} stats
 *  @param {Record<string, unknown>} extra */
function envelope(stats, extra) {
    return { ...extra, scanned: stats };
}

/** Human-readable window, so an answer can be read without recomputing what "24h" meant at the
 *  time the tool ran. */
function describeWindow(window) {
    return { since: new Date(window.since).toISOString(), until: new Date(window.until).toISOString() };
}

/**
 * Builds the MCP server. `logDir` is resolved and validated by main.js, and is the only
 * directory anything here is ever allowed to look at.
 * @param {string} logDir
 */
export function createServer(logDir) {
    const server = new McpServer({ name: 'winc-logs', version: '1.0.0' });

    server.registerTool(
        'logs_files',
        {
            title: 'List log files',
            description: 'Every rotated log file with its date, size, line count and the time span it actually '
                + 'covers. Call this first to see how much history exists before searching it.',
            inputSchema: {
                withSpans: z.boolean().optional().default(true)
                    .describe('Read each file to report its line count and first/last timestamp. Set false for a names-and-sizes-only listing.'),
            },
        },
        async ({ withSpans }) => {
            const files = await listLogFiles(logDir);
            const described = [];

            for (const file of files) {
                const base = {
                    name: file.name, date: file.date, sizeBytes: file.sizeBytes,
                    modified: new Date(file.mtimeMs).toISOString(),
                };
                if (withSpans === false) { described.push(base); continue; }

                const stats = emptyStats();
                let first, last;
                for await (const line of streamLogLines([file], {}, stats)) {
                    first ??= line.time;
                    last = line.time;
                }
                described.push({
                    ...base,
                    lines: stats.linesMatched,
                    malformed: stats.malformed,
                    from: first === undefined ? null : new Date(first).toISOString(),
                    to: last === undefined ? null : new Date(last).toISOString(),
                });
            }

            return json({ logDir, fileCount: described.length, files: described });
        },
    );

    server.registerTool(
        'logs_search',
        {
            title: 'Search log lines',
            description: 'The general-purpose read: every log line in a time window, narrowed by level, '
                + 'correlation id, URL substring or free text. Returns lines in chronological order.',
            inputSchema: {
                ...rangeShape,
                level: z.enum(/** @type {[string, ...string[]]} */ (LEVELS)).optional()
                    .describe('Lowest level to include. Defaults to all levels.'),
                contains: z.string().optional()
                    .describe('Case-insensitive substring, matched against the whole raw line.'),
                requestId: z.string().optional()
                    .describe('Exact correlation id. Prefer logs_request, which needs no other arguments.'),
                url: z.string().optional()
                    .describe('Case-insensitive substring of the request URL, e.g. "findings".'),
                limit: z.number().int().min(1).max(1000).optional().default(100)
                    .describe('Maximum lines to return.'),
                order: z.enum(['oldest', 'newest']).optional().default('newest')
                    .describe('Which matches survive the limit. Results are chronological either way.'),
            },
        },
        async ({ since, until, level, contains, requestId, url, limit, order }) => {
            const window = resolveRange({ since, until });
            /** @type {import('./types.js').LineFilter} */
            const filter = { since: window.since, until: window.until };
            if (level) filter.minLevel = LEVEL_VALUES[level];
            if (contains) filter.contains = contains;
            if (requestId) filter.requestId = requestId;
            if (url) filter.url = url;

            const files = await selectFiles(logDir, window.since, window.until);
            const { lines, stats } = await readLogLines(files, filter, { limit: limit ?? 100, order });

            return json(envelope(stats, {
                window: describeWindow(window),
                lines: lines.map((line) => projectLine(line)),
            }));
        },
    );

    server.registerTool(
        'logs_errors',
        {
            title: 'Recent errors',
            description: 'Everything that went wrong in a window: error-level lines and failing responses, '
                + 'which are not the same set — a route can answer 503 with a logged error, but a rate-limited '
                + 'request is only ever a 429 with no error line. Includes the error type, message and a truncated stack.',
            inputSchema: {
                ...rangeShape,
                includeClientErrors: z.boolean().optional().default(false)
                    .describe('Also count 4xx responses (429 rate limits, 404s). Off by default.'),
                limit: z.number().int().min(1).max(500).optional().default(50)
                    .describe('Maximum lines to return, newest kept.'),
            },
        },
        async ({ since, until, includeClientErrors, limit }) => {
            const window = resolveRange({ since, until });
            /** @type {import('./types.js').LineFilter} */
            const filter = {
                since: window.since, until: window.until,
                errors: includeClientErrors ? 'any' : 'server',
            };

            const files = await selectFiles(logDir, window.since, window.until);
            const { lines, stats } = await readLogLines(files, filter, { limit: limit ?? 50, order: 'newest' });

            return json(envelope(stats, {
                window: describeWindow(window),
                errors: lines.map((line) => projectLine(line, { stack: true })),
            }));
        },
    );

    server.registerTool(
        'logs_request',
        {
            title: 'One request, end to end',
            description: 'Every line carrying one correlation id, in order: retries, timed() steps, any error, '
                + 'and the completion line with status and total response time. This is the tool for "what '
                + 'actually happened in that request" — get the id from any other tool, or from the '
                + 'x-request-id response header the app itself echoes back.',
            inputSchema: {
                requestId: z.string().describe('The correlation id, as it appears in a line\'s requestId field.'),
                ...rangeShape,
            },
        },
        async ({ requestId, since, until }) => {
            // A correlation id is unique but says nothing about when it happened, so this one
            // defaults to a week rather than a day — the retention window bounds it anyway.
            const window = resolveRange({ since: since ?? '7d', until });
            const files = await selectFiles(logDir, window.since, window.until);
            const { lines, stats } = await readLogLines(
                files, { since: window.since, until: window.until, requestId },
                { limit: 500, order: 'oldest' },
            );

            const timeline = lines.map((line) => projectLine(line, { stack: true }));
            return json(envelope(stats, {
                requestId, window: describeWindow(window), found: timeline.length > 0, timeline,
            }));
        },
    );

    server.registerTool(
        'logs_slow_requests',
        {
            title: 'Slow requests, with their step breakdown',
            description: 'Completed requests slower than a threshold, each with the timed() step durations '
                + 'that made it up, so the answer to "why was it slow" comes back with the request rather '
                + 'than needing a second lookup.',
            inputSchema: {
                ...rangeShape,
                thresholdMs: z.number().int().min(0).optional().default(1000)
                    .describe('Minimum total response time in ms.'),
                limit: z.number().int().min(1).max(200).optional().default(20)
                    .describe('Maximum requests to return, slowest first.'),
            },
        },
        async ({ since, until, thresholdMs, limit }) => {
            const window = resolveRange({ since, until });
            const files = await selectFiles(logDir, window.since, window.until);

            const { lines, stats } = await readLogLines(
                files,
                { since: window.since, until: window.until, minResponseTime: thresholdMs ?? 1000 },
                { limit: 1000, order: 'newest' },
            );

            const slow = lines
                .sort((a, b) => (b.responseTime ?? 0) - (a.responseTime ?? 0))
                .slice(0, limit ?? 20);

            const wanted = new Set(slow.map((line) => line.reqId).filter((id) => Boolean(id)));
            const steps = wanted.size > 0 ? await collectSteps(files, window, wanted) : new Map();

            return json(envelope(stats, {
                window: describeWindow(window),
                thresholdMs: thresholdMs ?? 1000,
                requests: slow.map((line) => ({
                    ...projectLine(line),
                    steps: steps.get(line.reqId ?? '') ?? [],
                })),
            }));
        },
    );

    server.registerTool(
        'logs_latency',
        {
            title: 'Latency percentiles',
            description: 'p50/p95/p99, min, max, mean and count over a window, grouped either by route '
                + '(whole-request time as the client saw it, with finding ids collapsed into '
                + '/api/findings/:id/confirm) or by pipeline step (which part of the request spent the time). '
                + 'Slowest p95 first.',
            inputSchema: {
                ...rangeShape,
                groupBy: z.enum(['route', 'step']).optional().default('route')
                    .describe('Aggregate per route, or per pipeline step.'),
            },
        },
        async ({ since, until, groupBy }) => {
            const window = resolveRange({ since, until });
            const files = await selectFiles(logDir, window.since, window.until);

            // Streamed into an accumulator, never collected: percentiles need every sample in
            // the window, but only the numbers — see LatencyAccumulator.
            const stats = emptyStats();
            const accumulator = new LatencyAccumulator({ groupBy: groupBy ?? 'route' });
            for await (const line of streamLogLines(files, { since: window.since, until: window.until }, stats)) {
                accumulator.add(line);
            }
            const groups = accumulator.finish();

            return json(envelope(stats, { window: describeWindow(window), groupBy: groupBy ?? 'route', groups }));
        },
    );

    return server;
}

/**
 * Second pass over the same files, collecting timed()'s step lines for a known set of correlation
 * ids. Two passes rather than one because the step lines are written *before* the completion line
 * that reveals the request was slow — there is no way to know which ids matter until the first
 * pass ends.
 * @param {import('./types.js').LogFile[]} files
 * @param {{ since: number, until: number }} window
 * @param {Set<string>} wanted
 * @returns {Promise<Map<string, {label: string, durationMs: number}[]>>}
 */
async function collectSteps(files, window, wanted) {
    /** @type {Map<string, {label: string, durationMs: number}[]>} */
    const byRequest = new Map();
    const stats = emptyStats();

    for await (const line of streamLogLines(files, { since: window.since, until: window.until }, stats)) {
        const id = line.reqId;
        if (!id || !wanted.has(id)) continue;
        if (typeof line.label !== 'string' || typeof line.durationMs !== 'number') continue;

        const steps = byRequest.get(id);
        const step = { label: line.label, durationMs: line.durationMs };
        if (steps) steps.push(step);
        else byRequest.set(id, [step]);
    }

    return byRequest;
}
