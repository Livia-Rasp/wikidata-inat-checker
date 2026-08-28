// @ts-check
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    createScheduledTopup, evaluateTopup, evaluateBonusRun, isEligibleHour, ranToday,
} from '../server/scheduledTopup.js';

const CONFIG = {
    taxon: null, iucn: null, limit: 500, recheckAfter: undefined, dbFile: ':memory:',
    checkIntervalMs: 1000, quietHoursCount: 6, quietLookbackDays: 30,
    quietMinSampleDays: 7, dailyDeadlineHour: 23, requestLogRetentionDays: 60,
};

const DISCOVER_BUCKET = { capacity: 24, refillPerHour: 1 };
/** CONFIG plus the slice-10 fields — only the bonus-draw tests need these. */
const CONFIG_WITH_BUCKET = { ...CONFIG, discoverBucket: DISCOVER_BUCKET, bonusMinBucketFraction: 0.5 };

const T14 = Date.UTC(2026, 7, 22, 14); // 2026-08-22T14:00 UTC — not a quiet hour, not the deadline
const T3 = Date.UTC(2026, 7, 22, 3);   // a quiet hour
const T23 = Date.UTC(2026, 7, 22, 23); // the deadline hour

const TRUSTED_QUIET = { hours: [2, 3, 4, 5, 6, 7], sampleDays: 30 };
const NO_HISTORY = { hours: [], sampleDays: 0 };

// ---- pure functions ----

test('isEligibleHour: trusts the derived set once there is enough history', () => {
    assert.equal(isEligibleHour(3, TRUSTED_QUIET, 7), true);
    assert.equal(isEligibleHour(14, TRUSTED_QUIET, 7), false);
});

test('isEligibleHour: with too little history, every hour is eligible', () => {
    assert.equal(isEligibleHour(14, NO_HISTORY, 7), true, 'the bootstrap fallback');
});

test('ranToday: true only for a run whose startedAt is today (UTC)', () => {
    assert.equal(ranToday(null, T14), false, 'nothing has ever run');
    assert.equal(ranToday({ startedAt: '2026-08-22T01:00:00.000Z' }, T14), true);
    assert.equal(ranToday({ startedAt: '2026-08-21T23:59:00.000Z' }, T14), false, 'yesterday');
});

test('evaluateTopup: a running job always wins, whatever else is true', () => {
    const d = evaluateTopup({
        jobsState: 'running', lastScheduledRun: null, quiet: TRUSTED_QUIET, config: CONFIG, nowMs: T3,
    });
    assert.deepEqual(d, { action: 'skip', reason: 'already_running' });
});

test('evaluateTopup: already attempted today skips, regardless of outcome', () => {
    const d = evaluateTopup({
        jobsState: 'idle',
        lastScheduledRun: { startedAt: '2026-08-22T01:00:00.000Z' },
        quiet: TRUSTED_QUIET, config: CONFIG, nowMs: T3,
    });
    assert.deepEqual(d, { action: 'skip', reason: 'ran_today' });
});

test('evaluateTopup: starts during a quiet hour', () => {
    const d = evaluateTopup({
        jobsState: 'idle', lastScheduledRun: null, quiet: TRUSTED_QUIET, config: CONFIG, nowMs: T3,
    });
    assert.deepEqual(d, { action: 'start', reason: 'quiet_hour' });
});

test('evaluateTopup: waits outside quiet hours, before the deadline', () => {
    const d = evaluateTopup({
        jobsState: 'idle', lastScheduledRun: null, quiet: TRUSTED_QUIET, config: CONFIG, nowMs: T14,
    });
    assert.deepEqual(d, { action: 'skip', reason: 'not_quiet_yet' });
});

test('evaluateTopup: the deadline overrides quiet hours rather than miss the day', () => {
    const d = evaluateTopup({
        jobsState: 'idle', lastScheduledRun: null, quiet: TRUSTED_QUIET, config: CONFIG, nowMs: T23,
    });
    assert.deepEqual(d, { action: 'start', reason: 'deadline_catch_up' });
});

test('evaluateTopup: with no history yet, every hour is eligible (bootstrap)', () => {
    const d = evaluateTopup({
        jobsState: 'idle', lastScheduledRun: null, quiet: NO_HISTORY, config: CONFIG, nowMs: T14,
    });
    assert.deepEqual(d, { action: 'start', reason: 'quiet_hour' });
});

// ---- createScheduledTopup: the wiring, driven by calling the captured interval callback ----

function fakeJobs(state = 'idle') {
    const started = [];
    return { status: () => ({ state }), start: (config) => started.push(config), started };
}

/**
 * `lastScheduledRun` may be a single value (applied to every tool alike) or a function of the
 * tool name, for tests that need images and links to have run on different days. The
 * `bonus*`/`tokensRemaining`/`drawAdmits` options are only consulted by the slice-10 bonus-draw
 * tests below — every other test leaves them at defaults that make maybeBonusRun() start nothing.
 * @param {{lastScheduledRun?: object|null|((tool: string) => object|null), quiet?: object,
 *          openCount?: number, bonusLastRun?: object|null, tokensRemaining?: number,
 *          drawAdmits?: boolean}} [opts]
 */
function fakeStore(opts = {}) {
    const {
        lastScheduledRun = null, quiet = TRUSTED_QUIET, openCount = 1_000_000,
        bonusLastRun = null, tokensRemaining = 24, drawAdmits = true,
    } = opts;
    const quietCalls = [];
    const pruneCalls = [];
    const drawCalls = [];
    return {
        latestRun: (tool, filter) => {
            if (filter?.triggeredBy === 'schedule-bonus') return bonusLastRun;
            if (filter?.triggeredBy !== 'schedule') return null;
            return typeof lastScheduledRun === 'function' ? lastScheduledRun(tool) : lastScheduledRun;
        },
        quietHoursOfDay: (q) => { quietCalls.push(q); return quiet; },
        pruneRequestLog: (days) => { pruneCalls.push(days); return 0; },
        countFindings: () => openCount, // never consulted, but present in case something regresses
        discoverBudgetStatus: () => ({ tokensRemaining }),
        drawDiscoverBudget: (bucket, cfg) => {
            drawCalls.push({ bucket, cfg });
            return { admitted: drawAdmits, tokensRemaining: drawAdmits ? tokensRemaining - 1 : tokensRemaining };
        },
        quietCalls, pruneCalls, drawCalls,
    };
}

/** A fake setInterval that hands back the callback instead of a real timer. */
function fakeTimer() {
    let fn = null;
    return {
        setIntervalFn: (f) => { fn = f; return { unref() {} }; },
        clearIntervalFn: () => { fn = null; },
        fire: () => fn?.(),
        get armed() { return fn !== null; },
    };
}

test('start() arms the interval and stop() disarms it, idempotently', () => {
    const timer = fakeTimer();
    const topup = createScheduledTopup({
        store: fakeStore(), jobs: fakeJobs(), config: CONFIG, now: () => T3,
        setIntervalFn: timer.setIntervalFn, clearIntervalFn: timer.clearIntervalFn,
    });
    topup.start();
    assert.ok(timer.armed);
    topup.start(); // must not double-arm
    topup.stop();
    assert.ok(!timer.armed);
    topup.stop(); // must not throw when already stopped
});

test('a tick during a quiet hour starts a run with triggeredBy: schedule', () => {
    const jobs = fakeJobs();
    const timer = fakeTimer();
    const topup = createScheduledTopup({
        store: fakeStore(), jobs, config: CONFIG, now: () => T3,
        setIntervalFn: timer.setIntervalFn, clearIntervalFn: timer.clearIntervalFn,
    });
    topup.start();
    timer.fire();

    assert.equal(jobs.started.length, 1);
    assert.equal(jobs.started[0].triggeredBy, 'schedule');
    assert.equal(jobs.started[0].dbFile, ':memory:');
    assert.equal(jobs.started[0].tool, 'images', 'images is tried first');
});

test('once images has run today, the same tick tries links next', () => {
    const store = fakeStore({
        lastScheduledRun: (tool) => tool === 'images'
            ? { startedAt: '2026-08-22T01:00:00.000Z' } : null,
    });
    const jobs = fakeJobs();
    const timer = fakeTimer();
    const topup = createScheduledTopup({
        store, jobs, config: CONFIG, now: () => T3,
        setIntervalFn: timer.setIntervalFn, clearIntervalFn: timer.clearIntervalFn,
    });
    topup.start();
    timer.fire();

    assert.equal(jobs.started.length, 1);
    assert.equal(jobs.started[0].tool, 'links', 'images already ran today, so links gets the slot');
});

test('once images and links have both run today, the same tick tries names next', () => {
    const store = fakeStore({
        lastScheduledRun: (tool) => tool === 'images' || tool === 'links'
            ? { startedAt: '2026-08-22T01:00:00.000Z' } : null,
    });
    const jobs = fakeJobs();
    const timer = fakeTimer();
    const topup = createScheduledTopup({
        store, jobs, config: CONFIG, now: () => T3,
        setIntervalFn: timer.setIntervalFn, clearIntervalFn: timer.clearIntervalFn,
    });
    topup.start();
    timer.fire();

    assert.equal(jobs.started.length, 1);
    assert.equal(jobs.started[0].tool, 'names', 'images and links already ran today, so names gets the slot');
});

test('once every tool has run today, a tick starts nothing', () => {
    const store = fakeStore({ lastScheduledRun: () => ({ startedAt: '2026-08-22T01:00:00.000Z' }) });
    const jobs = fakeJobs();
    const timer = fakeTimer();
    const topup = createScheduledTopup({
        store, jobs, config: CONFIG, now: () => T3,
        setIntervalFn: timer.setIntervalFn, clearIntervalFn: timer.clearIntervalFn,
    });
    topup.start();
    timer.fire();
    assert.equal(jobs.started.length, 0);
});

test('a tick skips while a run is already going', () => {
    const jobs = fakeJobs('running');
    const timer = fakeTimer();
    const topup = createScheduledTopup({
        store: fakeStore(), jobs, config: CONFIG, now: () => T3,
        setIntervalFn: timer.setIntervalFn, clearIntervalFn: timer.clearIntervalFn,
    });
    topup.start();
    timer.fire();
    assert.equal(jobs.started.length, 0);
});

test('a tick skips once a scheduled run has already been attempted today', () => {
    const store = fakeStore({ lastScheduledRun: { startedAt: '2026-08-22T01:00:00.000Z' } });
    const jobs = fakeJobs();
    const timer = fakeTimer();
    const topup = createScheduledTopup({
        store, jobs, config: CONFIG, now: () => T3,
        setIntervalFn: timer.setIntervalFn, clearIntervalFn: timer.clearIntervalFn,
    });
    topup.start();
    timer.fire();
    assert.equal(jobs.started.length, 0, 'a quiet hour does not override the daily-once gate');
});

test('a tick waits outside quiet hours, then the deadline catches it up', () => {
    let clock = T14;
    const jobs = fakeJobs();
    const timer = fakeTimer();
    const topup = createScheduledTopup({
        store: fakeStore(), jobs, config: CONFIG, now: () => clock,
        setIntervalFn: timer.setIntervalFn, clearIntervalFn: timer.clearIntervalFn,
    });
    topup.start();
    timer.fire();
    assert.equal(jobs.started.length, 0, 'not quiet, and before the deadline');

    clock = T23;
    timer.fire();
    assert.equal(jobs.started.length, 1, 'the deadline ignores quiet hours rather than skip the day');
    assert.equal(jobs.started[0].triggeredBy, 'schedule');
});

test('a large open-findings backlog never blocks a run', () => {
    const store = fakeStore({ openCount: 50_000 });
    const jobs = fakeJobs();
    const timer = fakeTimer();
    const topup = createScheduledTopup({
        store, jobs, config: CONFIG, now: () => T3,
        setIntervalFn: timer.setIntervalFn, clearIntervalFn: timer.clearIntervalFn,
    });
    topup.start();
    timer.fire();
    assert.equal(jobs.started.length, 1, 'no threshold exists to check');
});

test('the quiet-hours cache is not recomputed within 24h, and is recomputed after', () => {
    let clock = T3;
    const store = fakeStore();
    const jobs = fakeJobs();
    const timer = fakeTimer();
    // ran_today blocks the second tick's jobs.start(), which is fine — this test is only about
    // how often quietHoursOfDay itself gets called.
    const topup = createScheduledTopup({
        store, jobs, config: CONFIG, now: () => clock,
        setIntervalFn: timer.setIntervalFn, clearIntervalFn: timer.clearIntervalFn,
    });
    topup.start();
    timer.fire();
    assert.equal(store.quietCalls.length, 1);

    clock = T3 + 60 * 60 * 1000; // one hour later, same day
    timer.fire();
    assert.equal(store.quietCalls.length, 1, 'still within the 24h cache window');

    clock = T3 + 25 * 60 * 60 * 1000; // past 24h
    timer.fire();
    assert.equal(store.quietCalls.length, 2, 'recomputed once stale');
});

test('getStatus reports the cached quiet hours and today-ness for an unattended feature to be checked against', () => {
    const store = fakeStore({ lastScheduledRun: { startedAt: '2026-08-22T01:00:00.000Z' } });
    const jobs = fakeJobs();
    const timer = fakeTimer();
    const topup = createScheduledTopup({
        store, jobs, config: CONFIG, now: () => T3,
        setIntervalFn: timer.setIntervalFn, clearIntervalFn: timer.clearIntervalFn,
    });

    assert.deepEqual(topup.getStatus(), {
        quietHours: [], sampleDays: 0, deadlineHour: 23,
        ranToday: { images: true, links: true, names: true },
    }, 'before the first tick, the cache is empty but ranToday still reads the store live');

    topup.start();
    timer.fire();
    assert.deepEqual(topup.getStatus().quietHours, TRUSTED_QUIET.hours, 'now populated');
});

// ---- evaluateBonusRun: the pure decision behind slice 10's bonus draw ----

const BONUS_ARGS = {
    jobsState: 'idle', bonusRanToday: false, allToolsRanToday: true,
    tokensRemaining: 20, bucketCapacity: 24, config: CONFIG_WITH_BUCKET, nowMs: T23,
};

test('evaluateBonusRun: a running job wins, same as the ordinary tick decision', () => {
    const d = evaluateBonusRun({ ...BONUS_ARGS, jobsState: 'running' });
    assert.deepEqual(d, { action: 'skip', reason: 'already_running' });
});

test('evaluateBonusRun: at most once a day', () => {
    const d = evaluateBonusRun({ ...BONUS_ARGS, bonusRanToday: true });
    assert.deepEqual(d, { action: 'skip', reason: 'bonus_ran_today' });
});

test('evaluateBonusRun: not before the deadline hour — reuses TOPUP_DAILY_DEADLINE_HOUR as "late"', () => {
    const d = evaluateBonusRun({ ...BONUS_ARGS, nowMs: T14 });
    assert.deepEqual(d, { action: 'skip', reason: 'not_late_yet' });
});

test('evaluateBonusRun: waits for every tool\'s own guaranteed slot to settle first', () => {
    const d = evaluateBonusRun({ ...BONUS_ARGS, allToolsRanToday: false });
    assert.deepEqual(d, { action: 'skip', reason: 'tools_not_settled' });
});

test('evaluateBonusRun: skips when the shared bucket has no meaningful surplus', () => {
    // capacity 24, minFraction 0.5 → needs >= 12 remaining; 10 is not enough.
    const d = evaluateBonusRun({ ...BONUS_ARGS, tokensRemaining: 10 });
    assert.deepEqual(d, { action: 'skip', reason: 'insufficient_surplus' });
});

test('evaluateBonusRun: starts once everything lines up', () => {
    const d = evaluateBonusRun(BONUS_ARGS);
    assert.deepEqual(d, { action: 'start', reason: 'surplus_available' });
});

// ---- the bonus draw, wired through tick() ----

const ALL_RAN_TODAY = () => ({ startedAt: '2026-08-22T01:00:00.000Z' });

test('a tick takes a bonus run late in the day once every tool has settled and the bucket has surplus', () => {
    const store = fakeStore({ lastScheduledRun: ALL_RAN_TODAY, tokensRemaining: 20 });
    const jobs = fakeJobs();
    const timer = fakeTimer();
    const topup = createScheduledTopup({
        store, jobs, config: CONFIG_WITH_BUCKET, now: () => T23,
        setIntervalFn: timer.setIntervalFn, clearIntervalFn: timer.clearIntervalFn,
    });
    topup.start();
    timer.fire();

    assert.equal(jobs.started.length, 1);
    assert.equal(jobs.started[0].tool, 'images', 'TOOLS[0] — a bonus is a once-a-day top-up, not a second full round');
    assert.equal(jobs.started[0].triggeredBy, 'schedule-bonus');
    assert.equal(store.drawCalls.length, 1);
    assert.deepEqual(store.drawCalls[0], { bucket: 'discover', cfg: DISCOVER_BUCKET });
});

test('a tick with no discoverBucket configured never calls the budget store at all', () => {
    // CONFIG (not CONFIG_WITH_BUCKET) — the default shape most deployments have today.
    const store = fakeStore({ lastScheduledRun: ALL_RAN_TODAY });
    const jobs = fakeJobs();
    const timer = fakeTimer();
    const topup = createScheduledTopup({
        store, jobs, config: CONFIG, now: () => T23,
        setIntervalFn: timer.setIntervalFn, clearIntervalFn: timer.clearIntervalFn,
    });
    topup.start();
    timer.fire();

    assert.equal(jobs.started.length, 0);
    assert.equal(store.drawCalls.length, 0, 'no bucket configured means nothing to draw from');
});

test('the bonus run does not fire twice in one day', () => {
    const store = fakeStore({
        lastScheduledRun: ALL_RAN_TODAY, tokensRemaining: 20,
        bonusLastRun: { startedAt: '2026-08-22T05:00:00.000Z' }, // already ran earlier today
    });
    const jobs = fakeJobs();
    const timer = fakeTimer();
    const topup = createScheduledTopup({
        store, jobs, config: CONFIG_WITH_BUCKET, now: () => T23,
        setIntervalFn: timer.setIntervalFn, clearIntervalFn: timer.clearIntervalFn,
    });
    topup.start();
    timer.fire();

    assert.equal(jobs.started.length, 0);
    assert.equal(store.drawCalls.length, 0, 'never even drew — the once-a-day gate is checked first');
});

test('the bonus run does not fire when the shared bucket is too depleted', () => {
    const store = fakeStore({ lastScheduledRun: ALL_RAN_TODAY, tokensRemaining: 5 }); // < 24 * 0.5
    const jobs = fakeJobs();
    const timer = fakeTimer();
    const topup = createScheduledTopup({
        store, jobs, config: CONFIG_WITH_BUCKET, now: () => T23,
        setIntervalFn: timer.setIntervalFn, clearIntervalFn: timer.clearIntervalFn,
    });
    topup.start();
    timer.fire();

    assert.equal(jobs.started.length, 0);
    assert.equal(store.drawCalls.length, 0, 'the status check alone was enough to skip, no draw attempted');
});

test('the bonus run does not fire before the deadline hour, even with everything else lined up', () => {
    const store = fakeStore({ lastScheduledRun: ALL_RAN_TODAY, tokensRemaining: 20 });
    const jobs = fakeJobs();
    const timer = fakeTimer();
    const topup = createScheduledTopup({
        store, jobs, config: CONFIG_WITH_BUCKET, now: () => T3, // a quiet hour, but not late
        setIntervalFn: timer.setIntervalFn, clearIntervalFn: timer.clearIntervalFn,
    });
    topup.start();
    timer.fire();

    assert.equal(jobs.started.length, 0);
});

test('a lost race against an on-demand draw between status() and the real draw is respected', () => {
    // tokensRemaining (via discoverBudgetStatus) says there's surplus, but the actual draw is
    // refused — an on-demand caller could have spent the last token in between the two reads.
    const store = fakeStore({
        lastScheduledRun: ALL_RAN_TODAY, tokensRemaining: 20, drawAdmits: false,
    });
    const jobs = fakeJobs();
    const timer = fakeTimer();
    const topup = createScheduledTopup({
        store, jobs, config: CONFIG_WITH_BUCKET, now: () => T23,
        setIntervalFn: timer.setIntervalFn, clearIntervalFn: timer.clearIntervalFn,
    });
    topup.start();
    timer.fire();

    assert.equal(store.drawCalls.length, 1, 'the draw was attempted');
    assert.equal(jobs.started.length, 0, 'but refused, so no run was started');
});

test('getStatus reports each tool\'s ranToday independently', () => {
    const store = fakeStore({
        lastScheduledRun: (tool) => tool === 'images'
            ? { startedAt: '2026-08-22T01:00:00.000Z' } : null,
    });
    const topup = createScheduledTopup({
        store, jobs: fakeJobs(), config: CONFIG, now: () => T3,
        setIntervalFn: fakeTimer().setIntervalFn, clearIntervalFn: fakeTimer().clearIntervalFn,
    });
    assert.deepEqual(topup.getStatus().ranToday, { images: true, links: false, names: false });
});
