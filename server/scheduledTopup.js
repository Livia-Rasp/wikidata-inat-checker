// @ts-check
// Slice 5b: a scheduled discovery top-up. Runs once a day, preferring a quiet hour derived from
// measured request volume, but with a deadline catch-up that ignores quiet hours rather than let
// a whole day pass with no run at all. A bigger backlog never blocks a run — see
// docs/findings-db-roadmap.md's 5b section for why that's a deliberate departure from the roadmap's
// original "only when the backlog is below a threshold" draft.
//
// This is just another caller of jobs.start(), in-process — the same single-flight lock and job
// runner server/routes/discover.js uses. That is also why it needs no privilege mechanism of its
// own: it never goes over HTTP, so the loopback-peer check in server/writeGuard.js never applies
// to it. Named to avoid colliding with web/js/topup.js, the unrelated client-side progress poller.

/** How stale the cached quiet-hours set may get before recomputing — the hysteresis the roadmap
 * calls for: a single noisy hour must not flip the eligible set tick to tick. */
const QUIET_HOURS_CACHE_MS = 24 * 60 * 60 * 1000;

/**
 * One on/off switch and one scope (taxon/iucn) drives a once-a-day attempt for each tool in turn
 * — decided with Livia rather than separate per-tool config. Each tool tracks its own daily-once
 * gate independently (its own `runs.tool` history), but only one job can ever be running, so a
 * tick starts at most one: the first tool that is both eligible and hasn't run today, in this
 * fixed order.
 */
const TOOLS = ['images', 'links'];

/** @param {number} ms */
function utcDate(ms) {
    return new Date(ms).toISOString().slice(0, 10);
}

/** @param {number} ms */
function utcHour(ms) {
    return new Date(ms).getUTCHours();
}

/**
 * Is `hourUTC` one of the derived quiet hours — or is there simply not enough history yet to
 * trust the derived set at all, in which case every hour is eligible (the bootstrap fallback)?
 * @param {number} hourUTC
 * @param {{hours: number[], sampleDays: number}} quiet
 * @param {number} minSampleDays
 */
export function isEligibleHour(hourUTC, quiet, minSampleDays) {
    if (quiet.sampleDays < minSampleDays) return true;
    return quiet.hours.includes(hourUTC);
}

/**
 * Has a scheduled run already been attempted today (UTC), whatever the outcome? Any attempt
 * counts, including a failed one — a persistently broken scope is retried tomorrow, not every
 * tick today.
 * @param {{startedAt: string}|null} lastScheduledRun
 * @param {number} nowMs
 */
export function ranToday(lastScheduledRun, nowMs) {
    return Boolean(lastScheduledRun) && lastScheduledRun.startedAt.slice(0, 10) === utcDate(nowMs);
}

/**
 * The pure decision at the heart of one tick: given the current state, should a top-up start now,
 * and why? No side effects, so this is the seam the whole gate is unit-tested through.
 * @param {{jobsState: string, lastScheduledRun: {startedAt: string}|null,
 *          quiet: {hours: number[], sampleDays: number},
 *          config: {quietMinSampleDays: number, dailyDeadlineHour: number}, nowMs: number}} args
 * @returns {{action: 'skip'|'start', reason: string}}
 */
export function evaluateTopup({ jobsState, lastScheduledRun, quiet, config, nowMs }) {
    if (jobsState === 'running') return { action: 'skip', reason: 'already_running' };
    if (ranToday(lastScheduledRun, nowMs)) return { action: 'skip', reason: 'ran_today' };

    const hour = utcHour(nowMs);
    const quietHour = isEligibleHour(hour, quiet, config.quietMinSampleDays);
    const pastDeadline = hour >= config.dailyDeadlineHour;
    if (!quietHour && !pastDeadline) return { action: 'skip', reason: 'not_quiet_yet' };

    return { action: 'start', reason: quietHour ? 'quiet_hour' : 'deadline_catch_up' };
}

/**
 * @param {{store: any, jobs: any, config: {
 *   taxon?: string|null, iucn?: string|null, limit: number, recheckAfter?: number, dbFile: string,
 *   checkIntervalMs: number, quietHoursCount: number, quietLookbackDays: number,
 *   quietMinSampleDays: number, dailyDeadlineHour: number, requestLogRetentionDays: number,
 * }, log?: any, now?: () => number, setIntervalFn?: Function, clearIntervalFn?: Function}} opts
 */
export function createScheduledTopup({
    store, jobs, config, log = { info() {}, warn() {}, error() {} },
    now = () => Date.now(), setIntervalFn = setInterval, clearIntervalFn = clearInterval,
}) {
    let timer = null;
    let quiet = { hours: [], sampleDays: 0 };
    /** @type {number|null} */
    let quietComputedAt = null;

    function refreshQuietHoursIfStale(nowMs) {
        if (quietComputedAt !== null && nowMs - quietComputedAt < QUIET_HOURS_CACHE_MS) return;
        quiet = store.quietHoursOfDay({
            lookbackDays: config.quietLookbackDays, quietHoursCount: config.quietHoursCount,
        });
        quietComputedAt = nowMs;
        // Same cadence as the recompute: no need for a separate retention timer.
        store.pruneRequestLog(config.requestLogRetentionDays);
    }

    function tick() {
        const nowMs = now();
        refreshQuietHoursIfStale(nowMs);
        // jobsState does not change within a tick — nothing here starts a second job — so it's
        // read once and shared by every tool's decision.
        const jobsState = jobs.status().state;
        for (const tool of TOOLS) {
            const lastScheduledRun = store.latestRun(tool, { triggeredBy: 'schedule' });
            const decision = evaluateTopup({ jobsState, lastScheduledRun, quiet, config, nowMs });

            if (decision.action === 'skip') {
                log.info({ tool, ...decision, hour: utcHour(nowMs) }, 'scheduled top-up check');
                continue;
            }
            log.info({ tool, ...decision, hour: utcHour(nowMs), quietHours: quiet.hours },
                'scheduled top-up starting');
            jobs.start({
                tool,
                scope: { taxon: config.taxon, iucn: config.iucn },
                limit: config.limit,
                recheckAfter: config.recheckAfter,
                dbFile: config.dbFile,
                triggeredBy: 'schedule',
            });
            return; // one job per tick, regardless of how many tools were eligible
        }
    }

    return {
        start() {
            if (timer) return;
            timer = setIntervalFn(tick, config.checkIntervalMs);
            timer.unref?.();
        },
        /** Idempotent, and safe to call before start(). */
        stop() {
            if (!timer) return;
            clearIntervalFn(timer);
            timer = null;
        },
        /**
         * The only visibility into "why hasn't it run" this unattended feature gets — there is no
         * alerting anywhere else in this project. `ranToday` is per tool: each has its own
         * daily-once gate, so "images ran, links hasn't yet" is a real, visible state.
         */
        getStatus() {
            return {
                quietHours: quiet.hours,
                sampleDays: quiet.sampleDays,
                deadlineHour: config.dailyDeadlineHour,
                ranToday: Object.fromEntries(TOOLS.map((tool) => [tool,
                    ranToday(store.latestRun(tool, { triggeredBy: 'schedule' }), now())])),
            };
        },
    };
}
