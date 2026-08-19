#!/usr/bin/env node
// @ts-check
// Regenerates the screenshots in docs/screenshots/ — `npm run screenshots`.
//
// The screenshots are documentation, so they go stale exactly like prose does: change anything
// under web/ and they start showing an app that no longer exists. Re-running this is the fix, and
// it is one command so there is no excuse not to.
//
// It drives headless Chromium over the DevTools Protocol directly. No Puppeteer, no Playwright —
// the repo has no dev dependencies and this is not worth breaking that for; Node's global
// WebSocket is all a CDP client needs. What it does need is a local Chromium or Chrome.
//
// The findings database is **copied** before the server sees it (`VACUUM INTO`), so a capture run
// can never write to the real backlog — the app has write endpoints, and a stray click during a
// capture must not cost you a skip you meant to keep.
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { dataPath } from '../lib/paths.js';

const SOURCE_DB = process.env.FINDINGS_DB || dataPath('findings.db');
const OUT_DIR = 'docs/screenshots';
const PORT = Number(process.env.SCREENSHOT_PORT) || 8099;
const ORIGIN = `http://127.0.0.1:${PORT}`;

// Rendered at 2x and displayed at half that, so the text stays sharp on a HiDPI screen while
// GitHub's ~830 px content column still gets a downscale rather than an upscale.
const WIDTH = 1280;
const SCALE = 2;

// A taxon with several CC-licensed photos, used for the gallery shot. taxon.html takes everything
// it needs from the query string, so this does not have to be in the backlog — but it does have to
// still be image-less on Wikidata, or the app is showing work that no longer exists. If this one is
// ever fixed, pick another from the worklist.
const GALLERY = { taxon_id: '140878', name: 'Bulbophyllum radicans', qid: 'Q4995566' };

// The clade for the search shot. Needs enough findings under it to fill the composition strip.
const SEARCH_TAXON = process.env.SCREENSHOT_TAXON || 'Orchidaceae';

/**
 * Pages to capture.
 *
 * `ready` must describe the page as a *reader* should see it, not merely "loaded". The gallery is
 * the cautionary case: its cards render immediately with a grey "Preparing…" button and fill in as
 * enrichment resolves, so a naive load check captures an app that looks broken.
 *
 * `crop` returns the pixel height to cut at, measured from the DOM so the cut lands on an element
 * boundary instead of slicing a row in half — and so it stays right when the content changes.
 */
const TARGETS = [
    {
        file: 'worklist.png',
        url: `${ORIGIN}/`,
        ready: `document.querySelectorAll('#tbody tr').length > 3`,
        crop: `document.querySelectorAll('#tbody tr')[1].getBoundingClientRect().bottom`,
    },
    {
        file: 'search.png',
        url: `${ORIGIN}/search.html?taxon=${encodeURIComponent(SEARCH_TAXON)}`,
        ready: `!!document.querySelector('.rail') && document.querySelectorAll('#tbody tr').length > 1`,
        crop: `document.querySelectorAll('#tbody tr')[0].getBoundingClientRect().bottom`,
    },
    {
        file: 'gallery.jpg',
        url: `${ORIGIN}/taxon.html?${new URLSearchParams(GALLERY)}`,
        // Photographs, so PNG is the wrong container — it was 5 MB where JPEG is a few hundred KB
        // at a quality nobody can fault in a screenshot. 1.5x rather than 2x for the same reason:
        // still more than twice GitHub's content width, at a third of the bytes.
        format: 'jpeg',
        quality: 82,
        scale: 1.5,
        // Every thumbnail decoded, and every upload link actually built. Enrichment is sequential
        // and throttled to Nominatim's ~1 req/s, so this legitimately takes a while.
        timeoutMs: 120_000,
        ready: `(() => {
            const imgs = [...document.querySelectorAll('.card img')];
            const pending = document.querySelectorAll('a.upload.disabled').length;
            return imgs.length > 3 && imgs.every(x => x.complete && x.naturalWidth > 0)
                && pending === 0 && !/preparing/i.test(document.getElementById('status').textContent);
        })()`,
        crop: `document.querySelectorAll('.card')[0].getBoundingClientRect().bottom`,
    },
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function die(msg) {
    console.error(`\n  ${msg}\n`);
    process.exit(1);
}

/** The first Chromium-family binary on PATH. */
async function findChrome() {
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

/** Minimal CDP client: request/response over one WebSocket, events ignored. */
async function connect(wsUrl) {
    const ws = new WebSocket(wsUrl);
    await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
    let seq = 0;
    const pending = new Map();
    ws.onmessage = (e) => {
        const msg = JSON.parse(/** @type {string} */ (e.data));
        const waiter = pending.get(msg.id);
        if (!waiter) return; // an event, not a reply
        pending.delete(msg.id);
        msg.error ? waiter.rej(new Error(msg.error.message)) : waiter.res(msg.result);
    };
    const send = (method, params = {}) => new Promise((res, rej) => {
        const id = ++seq;
        pending.set(id, { res, rej });
        ws.send(JSON.stringify({ id, method, params }));
    });
    return { send, close: () => ws.close() };
}

/** Poll an expression in the page until it is true, or give up. */
async function waitFor(cdp, expression, what, timeoutMs = 30_000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        const r = await cdp.send('Runtime.evaluate', { expression, returnByValue: true });
        if (r.result?.value === true) return;
        await sleep(250);
    }
    die(`Timed out waiting for ${what}. The page loaded but never reached the state worth capturing.`);
}

async function main() {
    const chrome = await findChrome();
    if (!chrome) die('No Chromium or Chrome found on PATH. Install one, or run the capture elsewhere.');
    console.log(`  ✓ ${chrome.version}`);

    if (!existsSync(SOURCE_DB)) {
        die(`No findings database at ${SOURCE_DB}.\n  ` +
            `Run a checker first — e.g. npm run images -- --limit 200 --iucn EN — so there is a\n  ` +
            `backlog to photograph. Screenshots of an empty worklist document nothing.`);
    }

    const work = mkdtempSync(join(tmpdir(), 'winc-shots-'));
    const dbCopy = join(work, 'shots.db');
    let server, browser, cdp;

    const cleanup = () => {
        try { cdp?.close(); } catch { /* already gone */ }
        browser?.kill();
        server?.kill();
        try { rmSync(work, { recursive: true, force: true }); } catch { /* best effort */ }
    };
    process.on('exit', cleanup);
    process.on('SIGINT', () => { cleanup(); process.exit(130); });

    // Copy rather than open: the server this starts can write, and the real backlog is the one
    // artifact in this repo that cannot be regenerated.
    {
        const db = new DatabaseSync(SOURCE_DB, { readOnly: true });
        db.exec(`VACUUM INTO '${dbCopy.replace(/'/g, "''")}'`);
        const open = db.prepare(`SELECT count(*) n FROM findings WHERE status = 'open'`).get();
        db.close();
        if (!open || Number(open.n) === 0) die('The findings database has no open findings to show.');
        console.log(`  ✓ ${open.n} open findings (working on a copy, not ${SOURCE_DB})`);
    }

    // DISCOVER_ENABLED so the search page shows its "Find more" control — it is part of the page,
    // and a screenshot without it documents a page nobody runs.
    server = spawn(process.execPath, ['server/index.js'], {
        env: { ...process.env, FINDINGS_DB: dbCopy, PORT: String(PORT), DISCOVER_ENABLED: '1', LOG_LEVEL: 'warn' },
        stdio: ['ignore', 'ignore', 'inherit'],
    });
    for (let i = 0; ; i++) {
        try { await fetch(`${ORIGIN}/api/findings?limit=1`); break; } catch { /* not up yet */ }
        if (i > 60) die(`Server did not come up on ${ORIGIN}.`);
        await sleep(250);
    }
    console.log(`  ✓ server on :${PORT}`);

    const profile = join(work, 'profile');
    browser = spawn(chrome.bin, [
        '--headless=new', '--no-sandbox', '--hide-scrollbars', '--force-device-scale-factor=1',
        '--remote-debugging-port=9333', `--user-data-dir=${profile}`, 'about:blank',
    ], { stdio: 'ignore' });

    let target;
    for (let i = 0; ; i++) {
        try { target = await (await fetch('http://127.0.0.1:9333/json/new?about:blank', { method: 'PUT' })).json(); break; }
        catch { /* not up yet */ }
        if (i > 60) die('Chromium did not expose a debugging port.');
        await sleep(250);
    }

    cdp = await connect(target.webSocketDebuggerUrl);
    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');

    mkdirSync(OUT_DIR, { recursive: true });
    for (const t of TARGETS) {
        // Tall viewport while measuring, so the element the crop is derived from is laid out and
        // in view; the clip below is what actually decides the image height.
        await cdp.send('Emulation.setDeviceMetricsOverride', {
            width: WIDTH, height: 2400, deviceScaleFactor: SCALE, mobile: false,
        });
        await cdp.send('Page.navigate', { url: t.url });
        await waitFor(cdp, t.ready, t.file, t.timeoutMs);
        await sleep(400); // let layout and web fonts settle before the shutter

        const measured = await cdp.send('Runtime.evaluate', {
            expression: `Math.ceil(${t.crop})`, returnByValue: true,
        });
        const height = Math.min(Number(measured.result?.value) || 800, 2400);

        const shot = await cdp.send('Page.captureScreenshot', {
            format: t.format || 'png',
            ...(t.quality ? { quality: t.quality } : {}),
            clip: { x: 0, y: 0, width: WIDTH, height, scale: t.scale || SCALE },
        });
        const out = join(OUT_DIR, t.file);
        writeFileSync(out, Buffer.from(shot.data, 'base64'));
        console.log(`  → ${out}  ${WIDTH}×${height}  ${(statSync(out).size / 1024).toFixed(0)} KB`);
    }

    console.log('\n  Screenshots regenerated. Commit them alongside the change that made them stale.');
}

await main();
process.exit(0);
