// @ts-check
// Parses the since/until arguments every tool accepts.

/** `<number><unit>`, e.g. `90m`, `24h`, `7d`. */
const RELATIVE = /^(\d+)\s*(m|h|d)$/i;

const UNIT_MS = {
    m: 60 * 1000,
    h: 60 * 60 * 1000,
    d: 24 * 60 * 60 * 1000,
};

/**
 * Turns one time input into epoch milliseconds.
 *
 * Accepts a relative age (`"24h"`, `"7d"`, `"90m"`) meaning "that long before now", an ISO 8601
 * timestamp, or epoch milliseconds. The relative form exists because it is what an agent actually
 * wants to say — asking "what broke today" should not require computing a timestamp first, and
 * getting that computation subtly wrong is how a log query silently answers about the wrong day.
 * @param {string | number} input
 * @param {number} [now]
 * @returns {number}
 */
export function parseTime(input, now = Date.now()) {
    if (typeof input === 'number') return input;

    const trimmed = input.trim();
    const relative = RELATIVE.exec(trimmed);
    if (relative) {
        const amount = Number(relative[1]);
        const unit = relative[2].toLowerCase();
        return now - amount * UNIT_MS[unit];
    }

    const parsed = Date.parse(trimmed);
    if (Number.isNaN(parsed)) {
        throw new Error(
            `Unrecognised time "${input}". Use a relative age ("24h", "7d"), an ISO timestamp, or epoch milliseconds.`);
    }
    return parsed;
}

/**
 * Resolves the since/until pair every tool accepts, defaulting to the last 24 hours — a window
 * that is almost always what was meant, and small enough that a default-arguments call can't
 * accidentally scan a week.
 * @param {{ since?: string | number, until?: string | number }} range
 * @param {number} [now]
 * @returns {{ since: number, until: number }}
 */
export function resolveRange(range, now = Date.now()) {
    const since = parseTime(range.since ?? '24h', now);
    const until = range.until === undefined ? now : parseTime(range.until, now);
    if (until < since) {
        throw new Error(`Empty time range: until (${new Date(until).toISOString()}) is before since.`);
    }
    return { since, until };
}
