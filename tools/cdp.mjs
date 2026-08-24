// @ts-check
// Shared plumbing for the two capture tools: `npm run screenshots` and `npm run record`.
//
// Both need the same four things — a Chromium on PATH, a throwaway copy of the findings database,
// a server pointed at that copy, and a minimal DevTools Protocol client. This module owns all
// four so the two tools cannot drift apart on any of them, which matters most for the database
// copy: it is the safety property that keeps a capture run from writing to the real backlog.
//
// No Puppeteer, no Playwright. The repo has no dev dependencies and this is not worth breaking
// that for; Node's global WebSocket is all a CDP client needs.
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Print a message and stop. Capture tools are interactive, so a stack trace helps nobody. */
export function die(msg) {
    console.error(`\n  ${msg}\n`);
    process.exit(1);
}

/** The first Chromium-family binary on PATH, with its version string. */
export async function findChrome() {
    for (const bin of ['chromium', 'chromium-browser', 'google-chrome', 'google-chrome-stable']) {
        const ok = await new Promise((res) => {
            const p = spawn(bin, ['--version'], { stdio: ['ignore', 'pipe', 'ignore'] });
            p.on('error', () => res(null));
            let out = '';
            p.stdout?.on('data', (d) => (out += d));
            p.on('exit', (code) => res(code === 0 ? out.trim() : null));
        });
        if (ok) return { bin, version: ok };
    }
    return null;
}

/**
 * How long to wait for a reply to any one CDP command before giving up on it.
 *
 * Every command gets a deadline, because the browser does not always answer. A
 * `Page.captureScreenshot` still in flight when a navigation commits is simply dropped, and with
 * no deadline that one lost reply hangs its caller for good — which is exactly how the recorder
 * first failed: the opening frame was issued on about:blank, the first navigation landed on top
 * of it, and the whole tool sat there until an external timeout killed it. A rejection lets the
 * caller retry the next frame, which is what it wanted to do anyway.
 *
 * Generous, because a legitimate slow reply must not be cut off: the ceiling is here to convert
 * "never" into "eventually", not to police latency.
 */
const CMD_TIMEOUT_MS = 20_000;

/** Minimal CDP client: request/response over one WebSocket. Events are delivered to `onEvent`. */
export async function connect(wsUrl, onEvent = null) {
    const ws = new WebSocket(wsUrl);
    await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
    let seq = 0;
    const pending = new Map();

    const settle = (id, fn, arg) => {
        const waiter = pending.get(id);
        if (!waiter) return;
        pending.delete(id);
        clearTimeout(waiter.timer);
        waiter[fn](arg);
    };

    ws.onmessage = (e) => {
        const msg = JSON.parse(/** @type {string} */ (e.data));
        if (msg.id === undefined) { onEvent?.(msg); return; }
        msg.error ? settle(msg.id, 'rej', new Error(msg.error.message))
                  : settle(msg.id, 'res', msg.result);
    };

    const send = (method, params = {}) => new Promise((res, rej) => {
        const id = ++seq;
        const timer = setTimeout(
            () => settle(id, 'rej', new Error(`${method} did not reply within ${CMD_TIMEOUT_MS}ms`)),
            CMD_TIMEOUT_MS);
        timer.unref?.();
        pending.set(id, { res, rej, timer });
        ws.send(JSON.stringify({ id, method, params }));
    });

    return { send, close: () => ws.close() };
}

/** Poll an expression in the page until it evaluates true, or give up and stop. */
export async function waitFor(cdp, expression, what, timeoutMs = 30_000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        const r = await cdp.send('Runtime.evaluate', { expression, returnByValue: true });
        if (r.result?.value === true) return;
        await sleep(250);
    }
    die(`Timed out waiting for ${what}. The page loaded but never reached the state worth capturing.`);
}

/**
 * Copy the findings database into `dest` and report how many open findings it holds.
 *
 * A copy, never the original. The server these tools start can write, and `data/findings.db` is
 * the one artifact in this repo that cannot be regenerated — a stray click during a capture must
 * not cost a skip somebody meant to keep.
 */
export function copyFindingsDb(sourceDb, dest) {
    if (!existsSync(sourceDb)) {
        die(`No findings database at ${sourceDb}.\n  ` +
            `Run a checker first — e.g. npm run images -- --limit 200 --iucn EN — so there is a\n  ` +
            `backlog to capture. A capture of an empty worklist documents nothing.`);
    }
    const db = new DatabaseSync(sourceDb, { readOnly: true });
    db.exec(`VACUUM INTO '${dest.replace(/'/g, "''")}'`);
    const open = db.prepare(`SELECT count(*) n FROM findings WHERE status = 'open'`).get();
    db.close();
    if (!open || Number(open.n) === 0) die('The findings database has no open findings to show.');
    return Number(open.n);
}

/**
 * Start the server against `dbPath` and wait for it to answer.
 *
 * DISCOVER_ENABLED so the search page shows its "Find more" control: it is part of the page, and
 * a capture without it documents a page nobody runs.
 */
export async function startServer(dbPath, port, origin) {
    const server = spawn(process.execPath, ['server/index.js'], {
        env: { ...process.env, FINDINGS_DB: dbPath, PORT: String(port), DISCOVER_ENABLED: '1', LOG_LEVEL: 'warn' },
        stdio: ['ignore', 'ignore', 'inherit'],
    });
    for (let i = 0; ; i++) {
        try { await fetch(`${origin}/api/findings?limit=1`); break; } catch { /* not up yet */ }
        if (i > 60) die(`Server did not come up on ${origin}.`);
        await sleep(250);
    }
    return server;
}

/**
 * Start headless Chromium with a throwaway profile and attach to a blank tab.
 *
 * The theme is pinned to dark rather than left to the headless browser's ambient default, so a
 * capture stays deterministic across machines and Chromium versions. A fresh profile has no
 * localStorage theme tag, so web/js/shell.js falls back to prefers-color-scheme, which this forces.
 */
export async function startBrowser(chromeBin, profileDir, debugPort, onEvent = null) {
    const browser = spawn(chromeBin, [
        '--headless=new', '--no-sandbox', '--hide-scrollbars', '--force-device-scale-factor=1',
        `--remote-debugging-port=${debugPort}`, `--user-data-dir=${profileDir}`, 'about:blank',
    ], { stdio: 'ignore' });

    let target;
    for (let i = 0; ; i++) {
        try {
            target = await (await fetch(`http://127.0.0.1:${debugPort}/json/new?about:blank`, { method: 'PUT' })).json();
            break;
        } catch { /* not up yet */ }
        if (i > 60) die('Chromium did not expose a debugging port.');
        await sleep(250);
    }

    const cdp = await connect(target.webSocketDebuggerUrl, onEvent);
    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');
    await cdp.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'dark' }] });
    return { browser, cdp };
}

/** A temp working directory plus the teardown that always has to go with it. */
export function makeWorkspace(prefix) {
    const dir = mkdtempSync(join(tmpdir(), prefix));
    const owned = { cdp: null, browser: null, server: null };
    const cleanup = () => {
        try { owned.cdp?.close(); } catch { /* already gone */ }
        owned.browser?.kill();
        owned.server?.kill();
        try { rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
    };
    process.on('exit', cleanup);
    process.on('SIGINT', () => { cleanup(); process.exit(130); });
    return { dir, owned, cleanup };
}
