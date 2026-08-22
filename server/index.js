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
import { LOOPBACK_ONLY } from './writeGuard.js';

const DB_FILE = findingsDbPath();
const PORT = Number(process.env.PORT) || 8080;
const HOST = process.env.HOST || '127.0.0.1';

/** `0` is a meaningful value for several of these (a deadline of midnight, an immediate recheck),
 * so `Number(x) || fallback` would be wrong for them — unset or empty is the only thing that means
 * "use the default". */
function envInt(name, fallback) {
    const raw = process.env[name];
    return raw === undefined || raw === '' ? fallback : Number(raw);
}

const discoverEnabled = Boolean(process.env.DISCOVER_ENABLED);

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
    store,
    logger: {
        level: process.env.LOG_LEVEL || 'info',
        // Fastify's default serialiser logs no headers, so nothing is exposed today. The redaction
        // is here because the sibling project leaked a foreign localhost cookie into its logs by
        // adding a serialiser later, and this process will hold OAuth tokens if that work happens.
        redact: ['req.headers.cookie', 'req.headers.authorization', 'res.headers["set-cookie"]'],
    },
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
