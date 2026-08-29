#!/usr/bin/env node
// @ts-check
import { stat } from 'node:fs/promises';
import path from 'node:path';
import { createHttpApp } from './http.js';

/** Reads `--name value` out of argv, or undefined. Flags win over the matching environment
 *  variable everywhere below.
 *  @param {string[]} argv @param {string} name */
function flag(argv, name) {
    const index = argv.indexOf(`--${name}`);
    return index === -1 ? undefined : argv[index + 1];
}

/**
 * Everything this process needs, resolved from flags and environment.
 *
 * The token is environment-only, deliberately: command-line arguments are world-readable
 * through `ps` on a shared box, and a secret that leaks that easily is not a secret.
 * @param {string[]} argv
 */
function resolveConfig(argv) {
    const logDir = flag(argv, 'logs') ?? process.env.LOG_DIR;
    if (!logDir) {
        throw new Error('No log directory configured. Pass --logs <dir> or set LOG_DIR.');
    }

    const token = process.env.MCP_AUTH_TOKEN;
    if (!token || token.length < 16) {
        throw new Error(
            'MCP_AUTH_TOKEN is missing or too short (16+ characters). Generate one with '
            + '`openssl rand -hex 32`. Refusing to start: this endpoint is published on the LAN.');
    }

    const allowedHosts = (flag(argv, 'allowed-hosts') ?? process.env.ALLOWED_HOSTS ?? 'localhost,127.0.0.1,[::1]')
        .split(',').map((host) => host.trim()).filter(Boolean);

    return {
        logDir: path.resolve(logDir),
        token,
        allowedHosts,
        port: Number(flag(argv, 'port') ?? process.env.PORT ?? 3400),
        bindHost: flag(argv, 'host') ?? process.env.BIND_HOST ?? '0.0.0.0',
    };
}

async function main() {
    const config = resolveConfig(process.argv.slice(2));

    const info = await stat(config.logDir).catch(() => null);
    if (!info?.isDirectory()) {
        throw new Error(`Log directory is not a directory: ${config.logDir}`);
    }

    const app = createHttpApp({ logDir: config.logDir, token: config.token, allowedHosts: config.allowedHosts });

    const httpServer = app.listen(config.port, config.bindHost, () => {
        // stderr, not stdout: this server speaks MCP over HTTP rather than stdio, so stdout is
        // free — but keeping every diagnostic on stderr means the same code could be given a
        // stdio transport without corrupting the protocol channel.
        process.stderr.write(
            `winc-logs: listening on http://${config.bindHost}:${config.port}/mcp, `
            + `reading ${config.logDir}, hosts allowed: ${config.allowedHosts.join(', ')}\n`);
    });

    // Express installs no SIGTERM handler of its own, so without this `docker stop` kills the
    // process outright — an exit code of 143, not 0, and every in-flight response cut off rather
    // than finished. There is nothing here to drain (every tool call is one request/response, no
    // background work survives it), so closing the listener and exiting is the whole shutdown.
    let closing = false;
    function shutdown() {
        if (closing) return;
        closing = true;
        httpServer.close(() => process.exit(0));
    }
    process.on('SIGTERM', shutdown);
    process.on('SIGINT', shutdown);
}

main().catch((error) => {
    process.stderr.write(`winc-logs: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
});
