#!/usr/bin/env node
// @ts-check
// Entry point for `npm run web`: opens the findings database, serves web/ and the API, and owns
// the store's lifetime (buildServer never closes a store it was handed).
//
// Binds 127.0.0.1 by default. The API is unauthenticated, so exposing it is a deliberate act:
// set HOST explicitly, and read docs/security.md first.
import { openFindingsDb } from '../lib/db.js';
import { dataPath } from '../lib/paths.js';
import { buildServer } from './app.js';

const DB_FILE = process.env.FINDINGS_DB || dataPath('findings.db');
const PORT = Number(process.env.PORT) || 8080;
const HOST = process.env.HOST || '127.0.0.1';

const store = openFindingsDb(DB_FILE);
const app = buildServer({
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
    app.log.info(`serving web/ and /api/findings from ${DB_FILE}`);
} catch (err) {
    app.log.error(err);
    store.close();
    process.exit(1);
}
