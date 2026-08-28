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
// and topping it up — lives on search.html (slice 5c). The worklist itself (paging, hide-done, the
// QuickStatements panel) is worklist.js's shared controller, configured for this kind — see its
// own header for why; what's unique to images (the picks-driven QuickStatements source, the
// uploaded-files list, the one-time legacy import) stays here.

import { getJson, postJson } from './api.js';
import { state } from './state.js';
import { legacy } from './cache.js';
import { mountShell } from './shell.js';
import { createWorklistPage } from './worklist.js';

mountShell('images');

const $ = (id) => /** @type {HTMLElement} */ (document.getElementById(id));

// ---- QuickStatements panel: P18 image + Commons-category sitelink ----
// A taxon contributes two commands as soon as a photo has been picked for it in a gallery tab.
// Copying no longer clears the picks — confirmation does, because that is the point at which the
// edit is known to exist. Copy, run the batch, then Confirm pending.
// Every field comes from the pick itself, which the server resolves against the database — not from
// the rows on screen. That is what lets this page be paged at all: deriving the finding id from the
// rendered table meant Confirm pending silently skipped every pick that was not on the visible page,
// which is a wrong answer wearing the shape of a right one.
function pendingQs() {
    return Object.entries(state.allPicks())
        .map(([qid, pick]) => ({
            qid,
            id: pick.findingId,
            file: pick.destFile,
            category: pick.taxonName || '',
        }))
        .filter((q) => q.file && q.category);
}

const page = createWorklistPage({
    kind: 'image',
    hideDoneKey: 'hide-done',
    postJson, getJson,
    qsPlaceholder: "Pick a Wikidata image (P18) in a taxon's gallery — its P18 and Commons-category "
        + 'sitelink statements appear here, ready to paste into QuickStatements. Copy them, run the '
        + 'batch, then Confirm pending: a taxon is only marked done once both statements are live '
        + 'on Wikidata.',
    fetchPending: async () => pendingQs(),
    qsLines: (pending) => pending
        .map((q) => `${q.qid}\tP18\t"${q.file}"\n${q.qid}\tScommonswiki\t"Category:${q.category}"`)
        .join('\n'),
    idsOf: (pending) => pending.map((q) => q.id).filter((id) => id != null),
    confirmMessage: (ok, total) => `${ok} of ${total} confirmed.`,
    qsCountText: (pending) => (pending.length ? `${pending.length} taxa · ${pending.length * 2} statements` : ''),
    // Picks/uploads live server-side; the QuickStatements panel and the uploaded count both read
    // the local mirror state.load() refreshes, so it rides along with every findings fetch.
    extraFetch: () => state.load(),
    onLoaded: () => { refreshUploadedCount(); page.refreshQuickStatements(); offerImport(); },
});

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
async function runImport() {
    const payload = legacy.read();
    $('import-msg').textContent = 'Importing…';
    try {
        const res = await postJson('api/import', payload);
        await state.load();
        // Imported "done" flags are not taken as truth — they were written when a QuickStatements
        // line was copied, which is no evidence it was ever pasted. They come back as work to
        // confirm, so the database only ever learns "done" from Wikidata itself.
        const results = await page.table.confirm(res.toConfirm);
        const ok = results.filter((r) => r.confirmed).length;
        legacy.clear();
        $('import-banner').hidden = true;
        $('status').textContent =
            `Imported ${res.uploads} uploaded files and ${res.picks} picks; `
            + `checked ${results.length} previously-done taxa against Wikidata, ${ok} confirmed.`;
        refreshUploadedCount();
        page.refreshQuickStatements();
    } catch (e) {
        $('import-msg').textContent = `Import failed: ${e.message}. Nothing was cleared.`;
    }
}

function offerImport() {
    if (!legacy.has()) return;
    const { done, uploaded, picks } = legacy.read();
    $('import-msg').textContent =
        `This browser still holds ${done.length} done marks, ${uploaded.length} uploaded files `
        + `and ${Object.keys(picks).length} image picks from before they were stored server-side.`;
    $('import-banner').hidden = false;
}

// ---- wiring ----
$('download-uploaded').addEventListener('click', downloadUploaded);
$('import-run').addEventListener('click', runImport);

// Picks made in a gallery tab must show up here when this tab regains focus.
window.addEventListener('focus', () => {
    state.load().then(() => { refreshUploadedCount(); page.refreshQuickStatements(); }).catch(() => {});
});

// ---- boot ----
page.load();
