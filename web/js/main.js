// Main view: loads the open image backlog from the server's /api/findings and renders a
// drafts.html-like table of image-less taxa. Each row links out to Wikidata, the iNat taxon and
// the Commons category, shows the draft Wikitext (click to copy), and opens the per-taxon photo
// gallery in a new tab.
//
// The done state is **confirm-gated** (slice 4). A row is not marked done because you say so; it
// is marked done because the server looked at live Wikidata and found both the image (P18) and the
// Commons-category sitelink there. Before this, picking a photo marked the taxon done immediately
// and copying the QuickStatements deleted the record of the pick — so the app claimed work was
// finished while destroying the evidence of what the work was.
//
// This page is the worklist you are working through. Finding *more* work — searching the backlog,
// and topping it up — lives on search.html (slice 5c).

import { getJson, postJson } from './api.js';
import { state } from './state.js';
import { legacy } from './cache.js';
import { createRowTable } from './rows.js';

const $ = (id) => document.getElementById(id);

/** The API's ceiling; past it the backlog is reported as truncated rather than silently cut. */
const API = 'api/findings?kind=image&status=open&limit=2000';

/** qid → taxon name, for the sitelink half of the QuickStatements. */
const taxaByQid = new Map();
/** qid → finding id, so a row can address its own endpoints. */
const idByQid = new Map();

let hidingDone = localStorage.getItem('hide-done') === '1';

const table = createRowTable({
    tbody: $('tbody'),
    postJson,
    hidingDone: () => hidingDone,
    onStatus: (msg) => { $('status').textContent = msg; },
    onChange: refreshQuickStatements,
});

function toggleHideDone() {
    hidingDone = !hidingDone;
    localStorage.setItem('hide-done', hidingDone ? '1' : '');
    $('hide-done').textContent = hidingDone ? 'Show done' : 'Hide done';
    document.querySelectorAll('tr.done').forEach((row) => row.classList.toggle('hide-done', hidingDone));
}

// ---- QuickStatements panel: P18 image + Commons-category sitelink ----
// A taxon contributes two commands as soon as a photo has been picked for it in a gallery tab.
// Copying no longer clears the picks — confirmation does, because that is the point at which the
// edit is known to exist. Copy, run the batch, then Confirm pending.
function pendingQs() {
    return Object.entries(state.allPicks())
        .map(([qid, pick]) => ({
            qid,
            file: pick.destFile,
            category: pick.taxonName || taxaByQid.get(qid) || '',
        }))
        .filter((q) => q.file && q.category);
}

function qsLines(pending) {
    return pending
        .map((q) => `${q.qid}\tP18\t"${q.file}"\n${q.qid}\tScommonswiki\t"Category:${q.category}"`)
        .join('\n');
}

function refreshQuickStatements() {
    const pending = pendingQs();
    $('qs-text').value = qsLines(pending);
    $('qs-count').textContent = pending.length
        ? `${pending.length} taxa · ${pending.length * 2} statements`
        : '';
    $('qs-copy').disabled = pending.length === 0;
    $('qs-confirm').disabled = pending.length === 0;
}

function copyQuickStatements() {
    const text = qsLines(pendingQs());
    if (!text) return;
    const done = () => { $('qs-hint').textContent = 'Copied. Run the batch, then Confirm pending.'; };
    if (navigator.clipboard) navigator.clipboard.writeText(text).then(done);
    else { $('qs-text').select(); document.execCommand('copy'); done(); }
}

/** Confirm every taxon that currently has a pick — the batch you just pasted. */
async function confirmPending() {
    const ids = pendingQs().map((q) => idByQid.get(q.qid)).filter((id) => id !== undefined);
    const results = await table.confirm(ids);
    const ok = results.filter((r) => r.confirmed).length;
    $('qs-hint').textContent = results.length
        ? `${ok} of ${results.length} confirmed.`
        : 'Nothing to confirm.';
}

// ---- uploaded-files backfill list: download button + count ----
function refreshUploadedCount() {
    const n = state.uploadCount();
    $('uploaded-count').textContent = n ? `${n} marked uploaded` : '';
}

function downloadUploaded() {
    const blob = new Blob([JSON.stringify(state.exportObject(), null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'uploaded-files.json';
    a.click();
    URL.revokeObjectURL(a.href);
}

// ---- one-time import of what this browser profile still holds ----
async function runImport(qids) {
    const payload = legacy.read(qids);
    $('import-msg').textContent = 'Importing…';
    try {
        const res = await postJson('api/import', payload);
        await state.load();
        // Imported "done" flags are not taken as truth — they were written when a QuickStatements
        // line was copied, which is no evidence it was ever pasted. They come back as work to
        // confirm, so the database only ever learns "done" from Wikidata itself.
        const results = await table.confirm(res.toConfirm);
        const ok = results.filter((r) => r.confirmed).length;
        legacy.clear(qids);
        $('import-banner').hidden = true;
        $('status').textContent =
            `Imported ${res.uploads} uploaded files and ${res.picks} picks; `
            + `checked ${results.length} previously-done taxa against Wikidata, ${ok} confirmed.`;
        refreshUploadedCount();
        refreshQuickStatements();
    } catch (e) {
        $('import-msg').textContent = `Import failed: ${e.message}. Nothing was cleared.`;
    }
}

function offerImport(qids) {
    if (!legacy.has(qids)) return;
    const { done, uploaded, picks } = legacy.read(qids);
    $('import-msg').textContent =
        `This browser still holds ${done.length} done marks, ${uploaded.length} uploaded files `
        + `and ${Object.keys(picks).length} image picks from before they were stored server-side.`;
    $('import-banner').hidden = false;
}

// ---- wiring ----
$('download-uploaded').addEventListener('click', downloadUploaded);
$('qs-copy').addEventListener('click', copyQuickStatements);
$('qs-confirm').addEventListener('click', confirmPending);
$('hide-done').addEventListener('click', toggleHideDone);
$('import-run').addEventListener('click', () => runImport([...idByQid.keys()]));

// Picks made in a gallery tab must show up here when this tab regains focus.
window.addEventListener('focus', () => {
    state.load().then(() => { refreshUploadedCount(); refreshQuickStatements(); }).catch(() => {});
});

async function load() {
    try {
        const [data] = await Promise.all([getJson(API), state.load()]);
        const taxa = data.taxa || [];
        taxa.forEach((t) => {
            if (t.qid && t.taxonName) taxaByQid.set(t.qid, t.taxonName);
            if (t.qid) idByQid.set(t.qid, t.id);
        });
        $('count').textContent = data.total > taxa.length
            ? `${taxa.length} of ${data.total} taxa`
            : `${taxa.length} taxa`;
        if (data.generated) $('generated').textContent = `backlog as of ${new Date(data.generated).toLocaleString()}`;
        table.render(taxa);
        if (hidingDone) $('hide-done').textContent = 'Show done';
        if (taxa.length === 0) {
            $('status').textContent = 'Nothing open in the backlog. Search for a clade to find more.';
        }
        refreshUploadedCount();
        refreshQuickStatements();
        offerImport([...idByQid.keys()]);
    } catch (e) {
        $('status').textContent = `Could not load the backlog from the server (${e.message}). Is \`npm run web\` still running?`;
    }
}

load();
