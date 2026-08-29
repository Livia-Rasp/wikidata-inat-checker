#!/usr/bin/env node
// @ts-check
// Regenerates the screenshots in docs/screenshots/ — `npm run screenshots`.
//
// The screenshots are documentation, so they go stale exactly like prose does: change anything
// under web/ and they start showing an app that no longer exists. Re-running this is the fix, and
// it is one command so there is no excuse not to.
//
// It drives headless Chromium over the DevTools Protocol directly. No Puppeteer, no Playwright —
// the repo has no dev dependencies and this is not worth breaking that for. What it does need is
// a local Chromium or Chrome. The CDP client, the browser and server startup, and the database
// copy live in tools/cdp.mjs, shared with `npm run record`.
//
// The findings database is **copied** before the server sees it (`VACUUM INTO`), so a capture run
// can never write to the real backlog — the app has write endpoints, and a stray click during a
// capture must not cost you a skip you meant to keep.
import { mkdirSync, writeFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { findingsDbPath } from '../lib/paths.js';
import {
    sleep, die, findChrome, waitFor, copyFindingsDb, startServer, startBrowser, setTheme, makeWorkspace,
} from './cdp.mjs';

// Captured once per theme, so the docs can show whichever matches the reader's own GitHub theme
// via a <picture> element — see docs/screenshots/README.md. `file` below is a base name; each
// theme's pass writes `<base>-<theme>.<ext>`.
const THEMES = ['dark', 'light'];

const SOURCE_DB = findingsDbPath();
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
        file: 'links.png',
        url: `${ORIGIN}/links.html`,
        // Waits for the review section to finish loading (its own async fetch, separate from the
        // worklist table) rather than requiring a review group specifically — the backlog's
        // ambiguous/conflict count is whatever it genuinely is at capture time, and a future
        // regeneration with none pending must still finish rather than time out.
        ready: `document.querySelectorAll('#tbody tr').length > 3 && document.getElementById('review-list').innerHTML.length > 0`,
        // The review section sits below however many worklist rows the real backlog has (the
        // worklist itself already looks like worklist.png's, so it isn't worth repeating at length
        // here) — `top` skips straight to it rather than capturing every row above.
        top: `document.getElementById('review').getBoundingClientRect().top`,
        crop: `document.getElementById('review').getBoundingClientRect().bottom`,
    },
    {
        file: 'names.png',
        url: `${ORIGIN}/names.html`,
        // No review section, unlike links.html — a name finding has no ambiguity to resolve, so
        // the worklist table alone is the whole page, the same shape worklist.png captures. Only
        // one row, unlike worklist.png's two: a name row's height varies with how many languages
        // are missing (a taxon can carry 20+), so even a single row is routinely much taller than
        // an images/links row — two would make an unusably tall capture.
        ready: `document.querySelectorAll('#tbody tr').length > 3`,
        crop: `document.querySelectorAll('#tbody tr')[0].getBoundingClientRect().bottom`,
    },
    {
        file: 'search.png',
        url: `${ORIGIN}/search.html?taxon=${encodeURIComponent(SEARCH_TAXON)}`,
        ready: `!!document.querySelector('.rail') && document.querySelectorAll('#tbody tr').length > 1`,
        crop: `document.querySelectorAll('#tbody tr')[0].getBoundingClientRect().bottom`,
    },
    {
        file: 'area.jpg',
        // Map tiles are photographic-density raster content, the same reason gallery.jpg below
        // isn't a PNG — this was 2.9 MB as one.
        format: 'jpeg',
        quality: 85,
        // lat/lng/radius pre-fill the picker (area.js reads them the same way search.html reads
        // ?taxon=) — a fresh profile has no localStorage history, so without this the capture would
        // show the empty first-load view rather than the picker in a state someone would leave it.
        url: `${ORIGIN}/area.html?lat=48.147&lng=11.589&radius=15`,
        ready: `!!document.querySelector('.leaflet-marker-icon') && !!document.querySelector('path.leaflet-interactive')
            && !!document.querySelector('.leaflet-tile-loaded')`,
        crop: `document.querySelector('.area-picker').getBoundingClientRect().bottom`,
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

async function main() {
    const chrome = await findChrome();
    if (!chrome) die('No Chromium or Chrome found on PATH. Install one, or run the capture elsewhere.');
    console.log(`  ✓ ${chrome.version}`);

    const { dir: work, owned } = makeWorkspace('winc-shots-');
    const dbCopy = join(work, 'shots.db');

    const open = copyFindingsDb(SOURCE_DB, dbCopy);
    console.log(`  ✓ ${open} open findings (working on a copy, not ${SOURCE_DB})`);

    owned.server = await startServer(dbCopy, PORT, ORIGIN);
    console.log(`  ✓ server on :${PORT}`);

    // One browser, both themes: setTheme() flips prefers-color-scheme between passes rather than
    // restarting Chromium, since nothing else about the capture changes.
    const { browser, cdp } = await startBrowser(chrome.bin, join(work, 'profile'), 9333, null, THEMES[0]);
    owned.browser = browser;
    owned.cdp = cdp;

    mkdirSync(OUT_DIR, { recursive: true });
    for (const theme of THEMES) {
        await setTheme(cdp, theme);
        for (const t of TARGETS) {
            // Tall viewport while measuring, so the element the crop is derived from is laid out
            // and in view; the clip below is what actually decides the image height.
            await cdp.send('Emulation.setDeviceMetricsOverride', {
                width: WIDTH, height: 2400, deviceScaleFactor: SCALE, mobile: false,
            });
            await cdp.send('Page.navigate', { url: t.url });
            await waitFor(cdp, t.ready, `${t.file} (${theme})`, t.timeoutMs);
            await sleep(400); // let layout and web fonts settle before the shutter

            // `top` lets a target start its clip below the page's actual top (links.png skips the
            // worklist rows sitting above the review section it exists to document) rather than
            // always capturing from y=0.
            const [measuredTop, measuredBottom] = await Promise.all([
                t.top ? cdp.send('Runtime.evaluate', { expression: `Math.floor(${t.top})`, returnByValue: true }) : null,
                cdp.send('Runtime.evaluate', { expression: `Math.ceil(${t.crop})`, returnByValue: true }),
            ]);
            const top = Math.max(0, Number(measuredTop?.result?.value) || 0);
            const bottom = Number(measuredBottom.result?.value) || 800;
            const height = Math.min(bottom - top, 3000);

            const shot = await cdp.send('Page.captureScreenshot', {
                format: t.format || 'png',
                ...(t.quality ? { quality: t.quality } : {}),
                // Beyond the emulated viewport whenever `top` pushes the clip past it (2400px) —
                // without this, content below the viewport's own height is never laid out at all.
                captureBeyondViewport: true,
                clip: { x: 0, y: top, width: WIDTH, height, scale: t.scale || SCALE },
            });
            // `worklist.png` → `worklist-dark.png` / `worklist-light.png`, so a <picture> element
            // in the docs can pick whichever matches the reader's own GitHub theme.
            const dot = t.file.lastIndexOf('.');
            const themed = `${t.file.slice(0, dot)}-${theme}${t.file.slice(dot)}`;
            const out = join(OUT_DIR, themed);
            writeFileSync(out, Buffer.from(shot.data, 'base64'));
            console.log(`  → ${out}  ${WIDTH}×${height}  ${(statSync(out).size / 1024).toFixed(0)} KB`);
        }
    }

    console.log('\n  Screenshots regenerated. Commit them alongside the change that made them stale.');
}

await main();
process.exit(0);
