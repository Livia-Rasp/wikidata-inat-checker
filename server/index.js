#!/usr/bin/env node
// @ts-check
// Entry point for `npm run web`: opens the findings database, serves web/ and the API, and owns
// the store's lifetime (buildServer never closes a store it was handed).
//
// Binds 127.0.0.1 by default. The API is unauthenticated, so exposing it is a deliberate act:
// set HOST explicitly, and read docs/threat-model.md first.
import { openFindingsDb } from '../lib/db.js';
import { dataPath } from '../lib/paths.js';
import { buildServer } from './app.js';
import { LOOPBACK_ONLY } from './writeGuard.js';

const DB_FILE = process.env.FINDINGS_DB || dataPath('findings.db');
const PORT = Number(process.env.PORT) || 8080;
const HOST = process.env.HOST || '127.0.0.1';

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
    discoverEnabled: Boolean(process.env.DISCOVER_ENABLED),
    store,
    logger: {
        level: process.env.LOG_LEVEL || 'info',
        // Fastify's default serialiser logs no headers, so nothing is exposed today. The redaction
        // is here because the sibling project leaked a foreign localhost cookie into its logs by
        // adding a serialiser later, and this process will hold OAuth tokens at slice 10.
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
        { discovery: process.env.DISCOVER_ENABLED ? 'enabled (local only)' : 'disabled' },
        `serving web/ and /api from ${DB_FILE}`);
} catch (err) {
    app.log.error(err);
    store.close();
    process.exit(1);
}
