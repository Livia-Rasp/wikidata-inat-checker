// @ts-check
// Latency aggregation. No asset-request filtering here, unlike the sibling vue-commons-gallery
// reader this was ported from: server/app.js's ApiOnlyLogController already suppresses every log
// line for a non-/api request, so no static asset ever reaches these files in the first place.

/**
 * Collapses a concrete URL onto the route that produced it.
 *
 * Without this, every finding id is its own "route" and no aggregate over
 * `/api/findings/:id/confirm` is possible at all. This app's only parameterised route shape is
 * `/api/findings/<numeric id>/(confirm|skip|unskip|pick)` — simpler than a general path-param
 * collapse, since that is the one place this app's own routes ever put an id in the URL.
 * @param {string} url
 * @returns {string}
 */
export function normaliseRoute(url) {
    const path = (url.split('?')[0] ?? url).replace(/\/+$/, '') || '/';
    const m = /^\/api\/findings\/\d+\/(confirm|skip|unskip|pick)$/.exec(path);
    if (m) return `/api/findings/:id/${m[1]}`;
    return path;
}

/**
 * Nearest-rank percentile over an already-sorted ascending array.
 *
 * Nearest-rank rather than interpolation because these samples are counts of milliseconds from a
 * handful of requests: an interpolated p95 would invent a duration no request ever had, which
 * reads badly in a log tool whose whole job is reporting what actually happened.
 * @param {number[]} sortedAscending
 * @param {number} p
 * @returns {number}
 */
export function percentile(sortedAscending, p) {
    if (sortedAscending.length === 0) return 0;
    const rank = Math.ceil((p / 100) * sortedAscending.length);
    const index = Math.min(Math.max(rank - 1, 0), sortedAscending.length - 1);
    return sortedAscending[index];
}

/**
 * @typedef {{ group: string, count: number, min: number, p50: number, p95: number, p99: number,
 *             max: number, mean: number }} LatencyGroup
 */

/**
 * Accumulates durations per group while lines stream past, holding numbers rather than log lines.
 *
 * The distinction matters: percentiles need *every* sample in the window, and a week of request
 * lines held in memory only to sort some numbers out of them is the one way this server could
 * hurt the box it observes.
 */
export class LatencyAccumulator {
    /** @param {{ groupBy: 'route' | 'step' }} options */
    constructor(options) {
        this.options = options;
        /** @type {Map<string, number[]>} */
        this.samples = new Map();
    }

    /**
     * Adds one line if it carries a duration this grouping cares about; ignores it otherwise, so
     * the caller can hand over every line it sees.
     *
     * `groupBy: 'route'` reads `responseTime` off Fastify's request-completion lines
     * (whole-request latency, as the client experienced it); `groupBy: 'step'` reads
     * `durationMs` off `timed()`'s lines (which part of the pipeline spent it). Both come out of
     * the same read, because both are just lines in the same file.
     * @param {import('./types.js').LogLine} line
     */
    add(line) {
        let group, value;

        if (this.options.groupBy === 'route') {
            const url = line.req?.url;
            if (typeof line.responseTime !== 'number' || typeof url !== 'string') return;
            group = normaliseRoute(url);
            value = line.responseTime;
        } else {
            if (typeof line.durationMs !== 'number' || typeof line.label !== 'string') return;
            group = line.label;
            value = line.durationMs;
        }

        const bucket = this.samples.get(group);
        if (bucket) bucket.push(value);
        else this.samples.set(group, [value]);
    }

    /** The finished summary, slowest p95 first. @returns {LatencyGroup[]} */
    finish() {
        const groups = [];

        for (const [group, values] of this.samples) {
            values.sort((a, b) => a - b);
            const sum = values.reduce((total, value) => total + value, 0);
            groups.push({
                group,
                count: values.length,
                min: values[0],
                p50: percentile(values, 50),
                p95: percentile(values, 95),
                p99: percentile(values, 99),
                max: values[values.length - 1],
                mean: Math.round(sum / values.length),
            });
        }

        return groups.sort((a, b) => b.p95 - a.p95 || b.count - a.count);
    }
}
