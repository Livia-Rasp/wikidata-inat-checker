#!/usr/bin/env node
// @ts-check
// Entry point for `npm run web`: opens the findings database, serves web/ and the API, and owns
// the store's lifetime (buildServer never closes a store it was handed).
//
// Binds 127.0.0.1 by default. The API is unauthenticated, so exposing it is a deliberate act:
// set HOST explicitly, and read docs/threat-model.md first.
import { openFindingsDb } from '../lib/db.js';
import { findingsDbPath } from '../lib/paths.js';
import { buildServer } from './app.js';
import { createLogger } from './logger.js';
import { LOOPBACK_ONLY } from './writeGuard.js';

const DB_FILE = findingsDbPath();
const HOST = process.env.HOST || '127.0.0.1';

/** `0` is a meaningful value for several of these (a deadline of midnight, an immediate recheck),
 * so `Number(x) || fallback` would be wrong for them — unset or empty is the only thing that means
 * "use the default". A malformed value (e.g. `PORT=abc`) fails loudly at startup rather than
 * silently becoming NaN and only surfacing later as a broken listener or a no-op scheduled run. */
function envInt(name, fallback) {
    const raw = process.env[name];
    if (raw === undefined || raw === '') return fallback;
    const n = Number(raw);
    if (!Number.isFinite(n)) throw new Error(`${name} must be a number, got ${JSON.stringify(raw)}`);
    return n;
}

const PORT = envInt('PORT', 8080);

const discoverEnabled = Boolean(process.env.DISCOVER_ENABLED);

// Slice 10: the token buckets POST /discover and GET /discover/area draw from, now that cost is
// bounded by budget rather than by a loopback-peer check a published Docker port could never
// satisfy. Sizing and the arithmetic behind these defaults are in docs/threat-model.md's
// "Discovery budget" section. Built unconditionally (not gated on DISCOVER_ENABLED) — the values
// are harmless to compute even when discovery itself is off, and server/scheduledTopup.js's
// bonus-draw path needs the same `discover` numbers topupConfig below is given.
const budgetConfig = {
    discover: {
        capacity: envInt('DISCOVER_BUDGET_CAPACITY', 24),
        refillPerHour: envInt('DISCOVER_BUDGET_REFILL_PER_HOUR', 1),
    },
    discover_area: {
        capacity: envInt('DISCOVER_AREA_BUDGET_CAPACITY', 120),
        refillPerHour: envInt('DISCOVER_AREA_BUDGET_REFILL_PER_HOUR', 5),
    },
};

// Slice 5b: a daily discovery top-up, preferring a quiet hour derived from measured request
// volume. Off unless configured; see docs/threat-model.md for the full variable table.
const topupConfig = {
    enabled: Boolean(process.env.TOPUP_ENABLED),
    taxon: process.env.TOPUP_TAXON || null,
    iucn: process.env.TOPUP_IUCN || null,
    limit: envInt('TOPUP_LIMIT', 500),
    recheckAfter: envInt('TOPUP_RECHECK_AFTER', undefined),
    checkIntervalMs: envInt('TOPUP_CHECK_INTERVAL_MINUTES', 30) * 60_000,
    quietHoursCount: envInt('TOPUP_QUIET_HOURS_COUNT', 6),
    quietLookbackDays: envInt('TOPUP_QUIET_LOOKBACK_DAYS', 30),
    quietMinSampleDays: envInt('TOPUP_QUIET_MIN_SAMPLE_DAYS', 7),
    dailyDeadlineHour: envInt('TOPUP_DAILY_DEADLINE_HOUR', 23),
    requestLogRetentionDays: envInt('TOPUP_REQUEST_LOG_RETENTION_DAYS', 60),
    // Slice 10: how much of the shared 'discover' bucket must still be unused, late in the day,
    // before the scheduler takes a bonus run on top of its own guaranteed once-a-day attempt.
    discoverBucket: budgetConfig.discover,
    bonusMinBucketFraction: envInt('TOPUP_BONUS_MIN_BUCKET_FRACTION', 0.5),
};

// A scheduled top-up spends the same API budget on-demand discovery does, so it needs the same
// flag. This is a misconfiguration, not a security exposure, so it degrades rather than refuses to
// start — the same posture slice 5d used for a missing taxa index.
if (topupConfig.enabled && !discoverEnabled) {
    console.error(
        'TOPUP_ENABLED is set but DISCOVER_ENABLED is not — a scheduled top-up spends the same '
        + 'Wikidata and iNaturalist API budget on-demand discovery does, so it needs the same flag. '
        + 'Disabling the scheduled top-up; the server will still start.');
    topupConfig.enabled = false;
}

// The API can change stored state and has no authentication, so reaching it must stay a deliberate
// act. Binding beyond loopback is refused rather than warned about: a warning in a log nobody reads
// is not a decision. Setting ALLOW_REMOTE_WRITES is that decision, made explicitly.
if (!LOOPBACK_ONLY.includes(HOST) && !process.env.ALLOW_REMOTE_WRITES) {
    console.error(
        `Refusing to bind ${HOST}: this API is unauthenticated and can change stored state.\n` +
        'Set ALLOW_REMOTE_WRITES=1 to do it anyway, and read docs/threat-model.md first — you will\n' +
        'also want ALLOWED_HOSTS set, or every write is rejected by the Host allowlist.');
    process.exit(1);
}

const store = openFindingsDb(DB_FILE);
// Nothing in-memory survives a restart, so a run still marked `running` in the database died
// without saying so. Say so for it, rather than leaving a row that looks alive forever.
const stale = store.reconcileRuns();

const app = buildServer({
    dbFile: DB_FILE,
    discoverEnabled,
    topupConfig,
    budgetConfig,
    store,
    // loggerInstance, not logger: this is an already-built pino instance (level, retention,
    // redaction and the dual stdout+file destination all live in server/logger.js now — see
    // docs/logging.md), and Fastify throws if a real instance is passed as `logger` instead.
    loggerInstance: createLogger(),
});

let closing = false;
async function shutdown(signal) {
    if (closing) return;
    closing = true;
    app.log.info({ signal }, 'shutting down');
    await app.close();
    store.close();
    process.exit(0);
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

try {
    await app.listen({ port: PORT, host: HOST });
    if (stale > 0) app.log.warn({ runs: stale }, 'marked interrupted runs from a previous process');
    app.log.info(
        {
            discovery: discoverEnabled ? 'enabled (local only)' : 'disabled',
            topup: topupConfig.enabled ? 'enabled' : 'disabled',
        },
        `serving web/ and /api from ${DB_FILE}`);
} catch (err) {
    app.log.error(err);
    store.close();
    process.exit(1);
}
