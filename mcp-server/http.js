// @ts-check
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { timingSafeEqual } from 'node:crypto';
import express from 'express';
import { createServer } from './server.js';

/** JSON-RPC's "invalid request" code, which is what a rejected HTTP request has to look like to
 *  a client that only speaks MCP. */
const INVALID_REQUEST = -32600;

/**
 * Compares two secrets without leaking their common prefix through timing.
 *
 * Lengths are compared first and separately because `timingSafeEqual` throws on a length
 * mismatch rather than returning false — that check is not itself constant-time, but a token's
 * *length* is not the secret.
 * @param {string} presented
 * @param {string} expected
 */
function secretsMatch(presented, expected) {
    const a = Buffer.from(presented, 'utf8');
    const b = Buffer.from(expected, 'utf8');
    return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * Rejects any request that doesn't present the shared token.
 *
 * A static bearer token rather than OAuth: this server has exactly one client (Claude Code, on
 * the operator's machine) on a LAN with no browser flow to hang an authorization server off.
 * What it must not be is *nothing* — the port is published on the LAN so the shell can move to a
 * second PC, and an unauthenticated log endpoint would hand every device on the network a
 * detailed history of this app's traffic.
 * @param {string} token
 */
export function requireToken(token) {
    return (/** @type {import('express').Request} */ req, /** @type {import('express').Response} */ res,
        /** @type {import('express').NextFunction} */ next) => {
        const header = req.get('authorization') ?? '';
        const presented = header.startsWith('Bearer ') ? header.slice('Bearer '.length).trim() : '';

        if (!presented || !secretsMatch(presented, token)) {
            res.status(401).json({
                jsonrpc: '2.0',
                error: { code: INVALID_REQUEST, message: 'Unauthorized: missing or invalid bearer token' },
                id: null,
            });
            return;
        }
        next();
    };
}

/**
 * Rejects requests whose Host header isn't one this server answers to.
 *
 * This is the DNS-rebinding defence the MCP spec requires of HTTP transports: without it, a page
 * in any browser on the LAN can be made to resolve an attacker's hostname to this address and
 * then drive tool calls against the port from inside the victim's network, with the browser
 * supplying reachability the attacker doesn't have. The SDK's own `allowedHosts` transport
 * option is deprecated in favour of exactly this middleware.
 * @param {string[]} allowed
 */
export function requireAllowedHost(allowed) {
    const permitted = new Set(allowed.map((host) => host.toLowerCase()));

    return (/** @type {import('express').Request} */ req, /** @type {import('express').Response} */ res,
        /** @type {import('express').NextFunction} */ next) => {
        const header = req.get('host') ?? '';
        // Strip the port: the allowlist is about *names*, and the port is fixed by whatever this
        // process bound to anyway. IPv6 literals keep their brackets, which is why the split is
        // from the right.
        const host = header.replace(/:\d+$/, '').toLowerCase();

        if (!permitted.has(host)) {
            res.status(403).json({
                jsonrpc: '2.0',
                error: { code: INVALID_REQUEST, message: `Forbidden: Host "${header}" is not allowed` },
                id: null,
            });
            return;
        }
        next();
    };
}

/**
 * The Express app serving one MCP endpoint at POST /mcp.
 *
 * Stateless: a fresh server and transport per request, torn down when the response closes.
 * There is no session to resume and no client that needs server-initiated messages — every tool
 * here answers one question from files on disk — so sessions would only add state to leak and
 * to expire.
 * @param {{ logDir: string, token: string, allowedHosts: string[] }} options
 * @returns {import('express').Express}
 */
export function createHttpApp({ logDir, token, allowedHosts }) {
    const app = express();

    // Registered ahead of the Host allowlist, and unauthenticated: something has to be able to
    // answer "is it up" without holding the token or being reachable under an approved name —
    // the container's own HEALTHCHECK calls this over 127.0.0.1, and it must not start failing
    // because ALLOWED_HOSTS was tightened. Safe to expose because it says nothing but "ok".
    app.get('/healthz', (_req, res) => {
        res.json({ status: 'ok' });
    });

    app.use(requireAllowedHost(allowedHosts));
    app.use(express.json({ limit: '1mb' }));

    app.post('/mcp', requireToken(token), async (req, res) => {
        const server = createServer(logDir);
        // No `sessionIdGenerator` at all is the SDK's stateless mode.
        const transport = new StreamableHTTPServerTransport({});

        res.on('close', () => {
            void transport.close();
            void server.close();
        });

        try {
            await server.connect(transport);
            await transport.handleRequest(req, res, req.body);
        } catch (error) {
            process.stderr.write(`winc-logs: request failed: ${describe(error)}\n`);
            if (!res.headersSent) {
                res.status(500).json({
                    jsonrpc: '2.0',
                    error: { code: -32603, message: 'Internal server error' },
                    id: null,
                });
            }
        }
    });

    // Stateless mode has no standalone SSE stream to open and no session to delete, so both
    // verbs the spec allows on this endpoint are answered honestly rather than left to
    // Express's default 404.
    app.all('/mcp', (_req, res) => {
        res.status(405).json({
            jsonrpc: '2.0',
            error: { code: INVALID_REQUEST, message: 'Method not allowed: this endpoint is stateless, use POST' },
            id: null,
        });
    });

    return app;
}

/** Error message without assuming the thrown thing is an Error. @param {unknown} error */
function describe(error) {
    return error instanceof Error ? error.message : String(error);
}
