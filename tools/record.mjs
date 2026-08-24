#!/usr/bin/env node
// @ts-check
// Records docs/screenshots/demo.gif — `npm run record`.
//
// The screenshots show four pages standing still. What they cannot show is the thing the app is
// actually for: that a photo goes from iNaturalist to Commons to Wikidata, and that the app
// refuses to call any of it done until it has asked Wikidata. That is a sequence, so it needs a
// recording.
//
// Needs a local Chromium (as `npm run screenshots` does) and ffmpeg. Everything else — the CDP
// client, the server, the throwaway database copy — comes from tools/cdp.mjs.
//
// **The confirm at the end is real.** It runs against live Wikidata and it succeeds, because the
// taxon it confirms genuinely has both halves of this app's edit on Wikidata right now: the image
// (P18) and the Commons-category sitelink. Nothing is stubbed and no response is faked. If the
// taxon below ever stops satisfying that, this script says so and stops rather than recording a
// confirm that fails — see pickConfirmable().
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync, statSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { findingsDbPath } from '../lib/paths.js';
import { fetchEntitiesBatched } from '../lib/utils.js';
import {
    sleep, die, findChrome, waitFor, copyFindingsDb, startServer, startBrowser, makeWorkspace,
} from './cdp.mjs';

const SOURCE_DB = findingsDbPath();
const OUT_DIR = 'docs/screenshots';
const OUT_FILE = join(OUT_DIR, 'demo.gif');
const PORT = Number(process.env.RECORD_PORT) || 8098;
const ORIGIN = `http://127.0.0.1:${PORT}`;

// 1000px is wide enough for the worklist's columns and narrow enough that the GIF stays small.
// Device scale 1, unlike the screenshots' 2: a GIF is 256 colours, so the extra pixels cost
// megabytes and buy nothing.
const WIDTH = 1000;
const HEIGHT = 620;
const FPS = 8;

/**
 * How long a step's result should stay on screen before the next one starts.
 *
 * A recording that moves at the speed the machine can click is unreadable. These are the pauses
 * that make it a demonstration rather than a stress test.
 */
const BEAT = 900;

/**
 * Find a backlog taxon whose edit is genuinely complete on live Wikidata, so the recorded confirm
 * succeeds honestly.
 *
 * This is the whole reason the recording can end where it does. A confirm against a taxon nobody
 * has edited fails, correctly, and a demo ending in a failure sells nothing. Rather than stub the
 * check, this asks Wikidata which of the open findings already have both halves — someone else
 * fixing a taxon upstream is common enough that there is usually one — and drives the demo with
 * that taxon. The confirm then passes because it deserves to.
 */
async function pickConfirmable(dbPath) {
    const db = new DatabaseSync(dbPath, { readOnly: true });
    const rows = db.prepare(`
        SELECT t.qid, t.taxon_name, t.inat_id
        FROM findings f JOIN taxa t ON t.qid = f.qid
        WHERE f.status = 'open' AND t.taxon_name IS NOT NULL
        LIMIT 200`).all();
    db.close();

    const entities = await fetchEntitiesBatched(rows.map(r => String(r.qid)),
        { props: 'claims|sitelinks', sitefilter: 'commonswiki' });

    for (const row of rows) {
        const e = entities[String(row.qid)];
        if (!e || e.missing) continue;
        const file = e.claims?.P18?.[0]?.mainsnak?.datavalue?.value;
        const category = e.sitelinks?.commonswiki?.title;
        if (file && category) {
            return { qid: String(row.qid), name: String(row.taxon_name),
                     inatId: String(row.inat_id), file: String(file), category: String(category) };
        }
    }
    return null;
}

/** Evaluate an expression in the page and return its value. */
async function evaluate(cdp, expression) {
    const r = await cdp.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.text ?? 'page threw');
    return r.result?.value;
}

/**
 * Capture PNG frames on a fixed timer for as long as `run` takes.
 *
 * Fixed-interval `Page.captureScreenshot` rather than `Page.startScreencast`. The screencast API
 * delivers frames only when the compositor decides something changed, which drops exactly the
 * still moments this recording is made of — a reader needs time on the result of each step, and
 * a frame stream that skips them plays back as a slideshow of transitions.
 */
async function recordWhile(cdp, framesDir, run) {
    let n = 0;
    let stop = false;
    // A dropped frame is normal: a navigation can land mid-capture and the next frame covers it.
    // Every frame dropping is not, and the two are indistinguishable if the failure is swallowed,
    // so the first reason is kept and reported rather than discarded.
    let firstError = null;
    let dropped = 0;

    const shutter = (async () => {
        while (!stop) {
            const started = Date.now();
            try {
                // No `clip`. A clip is measured from the document origin, so as soon as a step
                // scrolls the page the requested rectangle is no longer in the compositor's
                // surface and comes back blank — which silently blanked a third of the first
                // working recording, including the confirm at the end. Capturing the viewport
                // instead follows the scroll, which is also what a viewer should see.
                const shot = await cdp.send('Page.captureScreenshot', { format: 'png' });
                writeFileSync(join(framesDir, `f${String(n++).padStart(5, '0')}.png`),
                    Buffer.from(shot.data, 'base64'));
            } catch (err) {
                dropped++;
                firstError ??= err;
            }
            await sleep(Math.max(0, 1000 / FPS - (Date.now() - started)));
        }
    })();

    try { await run(); } finally { stop = true; await shutter; }

    if (n === 0) die(`Captured no frames at all. First failure: ${firstError?.message ?? 'unknown'}`);
    if (dropped > 0) console.log(`  ! dropped ${dropped} frame(s); first: ${firstError?.message}`);

    // A frame can arrive successfully and still be blank — an empty PNG is small, valid, and
    // encodes without complaint. The first working version of this script blanked a third of its
    // frames that way and the GIF looked fine in every log line, so blankness is checked rather
    // than assumed. The threshold is generous: a real frame of this app is hundreds of KB.
    const blank = readdirSync(framesDir)
        .filter((f) => f.endsWith('.png'))
        .filter((f) => statSync(join(framesDir, f)).size < 20_000).length;
    if (blank > n / 10) {
        die(`${blank} of ${n} captured frames are blank. Something scrolled or navigated out from\n  ` +
            `under the capture; a recording that is mostly empty is not worth publishing.`);
    }
    if (blank > 0) console.log(`  ! ${blank} blank frame(s) of ${n}`);
    return n;
}

/** Run ffmpeg and resolve on a clean exit. */
function ffmpeg(args) {
    return new Promise((res, rej) => {
        const p = spawn('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...args], { stdio: 'inherit' });
        p.on('error', () => rej(new Error('ffmpeg is not on PATH. Install it, or skip `npm run record`.')));
        p.on('exit', (code) => (code === 0 ? res(undefined) : rej(new Error(`ffmpeg exited ${code}`))));
    });
}

/**
 * Encode the frames as a GIF through a generated palette.
 *
 * Two passes, because GIF is limited to 256 colours: palettegen reads the whole recording and
 * picks the best 256 for it, then paletteuse dithers against that. A single-pass encode uses a
 * generic web palette and turns the app's photographs into banded mud.
 */
async function encode(framesDir, out) {
    const palette = join(framesDir, 'palette.png');
    const input = join(framesDir, 'f%05d.png');
    await ffmpeg(['-framerate', String(FPS), '-i', input,
        '-vf', 'palettegen=stats_mode=diff', palette]);
    await ffmpeg(['-framerate', String(FPS), '-i', input, '-i', palette,
        '-lavfi', 'paletteuse=dither=bayer:bayer_scale=5:diff_mode=rectangle',
        '-loop', '0', out]);
}

async function main() {
    const chrome = await findChrome();
    if (!chrome) die('No Chromium or Chrome found on PATH. Install one, or run the recording elsewhere.');
    console.log(`  ✓ ${chrome.version}`);

    const { dir: work, owned } = makeWorkspace('winc-record-');
    const dbCopy = join(work, 'record.db');
    const framesDir = join(work, 'frames');
    mkdirSync(framesDir, { recursive: true });

    const open = copyFindingsDb(SOURCE_DB, dbCopy);
    console.log(`  ✓ ${open} open findings (working on a copy, not ${SOURCE_DB})`);

    console.log('  … asking Wikidata which backlog taxon is already complete');
    const subject = await pickConfirmable(dbCopy);
    if (!subject) {
        die('No open finding currently has both a P18 and a Commons-category sitelink on Wikidata.\n  ' +
            'The recording ends on a confirm that succeeds, and this one would fail, so it is not\n  ' +
            'worth recording. Run `npm run images` to widen the backlog and try again.');
    }
    console.log(`  ✓ ${subject.name} (${subject.qid}) — P18 and Category:${subject.category} are both live`);

    owned.server = await startServer(dbCopy, PORT, ORIGIN);
    console.log(`  ✓ server on :${PORT}`);

    const { browser, cdp } = await startBrowser(chrome.bin, join(work, 'profile'), 9334);
    owned.browser = browser;
    owned.cdp = cdp;
    await cdp.send('Emulation.setDeviceMetricsOverride',
        { width: WIDTH, height: HEIGHT, deviceScaleFactor: 1, mobile: false });

    const q = JSON.stringify(subject.qid);
    const rowSel = `document.querySelector('[data-qid=' + CSS.escape(${q}) + ']')`;

    // Each step announces itself. A recording run is minutes long and mostly silent, and the
    // gallery step in particular waits on throttled third-party enrichment, so without this a
    // slow step and a hung one look identical.
    const step = (n, what) => console.log(`  … ${n}/5 ${what}`);

    // Load the first page before the shutter opens. A capture in flight when a navigation commits
    // is dropped by the browser, and the opening frame would otherwise always race the first
    // navigation — one guaranteed lost frame, and a wasted retry, at the very start of every run.
    step(1, 'the worklist');
    await cdp.send('Page.navigate', { url: `${ORIGIN}/` });
    await waitFor(cdp, `document.querySelectorAll('#tbody tr').length > 3`, 'the worklist');
    // Rows in the DOM is not the same as pixels on screen. Without this the opening second of the
    // recording is blank, because the shutter beats the first paint.
    await sleep(1200);

    const frames = await recordWhile(cdp, framesDir, async () => {
        // 1. The worklist, scrolled to the taxon this demo is about.
        await waitFor(cdp, `!!${rowSel}`, `${subject.name} in the worklist`);
        await evaluate(cdp, `${rowSel}.scrollIntoView({block: 'center'}); true`);
        await sleep(BEAT * 2);

        // 2. That taxon's gallery: its CC-licensed iNaturalist photos, each with a pre-filled
        //    Commons upload link. Opened directly rather than through the row's "View photos"
        //    link, which targets a new tab the recording would not follow.
        step(2, `${subject.name}'s gallery (waits on throttled enrichment)`);
        const gallery = `${ORIGIN}/taxon.html?` + new URLSearchParams({
            taxon_id: subject.inatId, name: subject.name, qid: subject.qid,
        });
        await cdp.send('Page.navigate', { url: gallery });
        // Only the cards actually on screen need to be ready. Enrichment is sequential and
        // throttled to Nominatim's ~1 req/s, so waiting for all of a well-photographed taxon's
        // cards would mean a minute of nothing happening in the middle of the recording.
        await waitFor(cdp, `(() => {
            const cards = [...document.querySelectorAll('.card')].slice(0, 3);
            if (cards.length === 0) return false;
            return cards.every((c) => {
                const img = c.querySelector('img');
                const upload = c.querySelector('a.upload');
                return img && img.complete && img.naturalWidth > 0
                    && upload && !upload.classList.contains('disabled');
            });
        })()`, 'the first gallery cards to enrich', 180_000);
        await sleep(BEAT * 2);

        // 3. Pick one photo as the item's image. This queues the taxon's two QuickStatements.
        step(3, 'picking the photo as P18');
        await evaluate(cdp, `(() => {
            const card = document.querySelector('.card');
            card.scrollIntoView({block: 'center'});
            card.querySelector('.p18 input').click();
            return true;
        })()`);
        await waitFor(cdp, `!!document.querySelector('.card.p18-selected')`, 'the photo to be picked');
        await sleep(BEAT * 2);

        // 4. Back on the worklist, the QuickStatements panel holds both statements.
        step(4, 'the QuickStatements panel');
        await cdp.send('Page.navigate', { url: `${ORIGIN}/` });
        await waitFor(cdp, `document.querySelector('#qs-text').value.includes(${q})`,
            'the QuickStatements panel to fill');
        await evaluate(cdp, `document.querySelector('#qs-panel').scrollIntoView({block: 'center'}); true`);
        await sleep(BEAT * 3);

        // 5. Confirm. In real use you would run the batch on QuickStatements first; here the two
        //    statements are already live, which is why this taxon was chosen. The server asks the
        //    Wikidata Action API and marks the finding done only because both halves are there.
        step(5, 'confirming against live Wikidata');
        await evaluate(cdp, `(() => {
            ${rowSel}.scrollIntoView({block: 'center'});
            ${rowSel}.querySelector('.confirm-btn').click();
            return true;
        })()`);
        await waitFor(cdp, `${rowSel}.classList.contains('done')`,
            'the confirm to come back from Wikidata', 60_000);
        await sleep(BEAT * 4);
    });

    console.log(`  ✓ ${frames} frames`);
    mkdirSync(OUT_DIR, { recursive: true });
    await encode(framesDir, OUT_FILE);

    const kb = statSync(OUT_FILE).size / 1024;
    console.log(`  → ${OUT_FILE}  ${WIDTH}×${HEIGHT}  ${kb.toFixed(0)} KB`);
    if (kb > 5 * 1024) {
        console.log('  ! Over 5 MB. Drop FPS or WIDTH before trading away legibility.');
    }
    console.log('\n  Recording regenerated. Commit it alongside the change that made it stale.');
}

await main();
process.exit(0);
