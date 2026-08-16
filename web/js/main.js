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

import { getJson, postJson } from './api.js';
import { state } from './state.js';
import { legacy } from './cache.js';

const $ = (id) => document.getElementById(id);
const INAT_OBS = (id) =>
    `https://www.inaturalist.org/observations?taxon_id=${id}&photo_license=cc0%2Ccc-by%2Ccc-by-sa&quality_grade=research`;

/** The API's ceiling; past it the backlog is reported as truncated rather than silently cut. */
const API = 'api/findings?kind=image&status=open&limit=2000';

/** qid → taxon name, for the sitelink half of the QuickStatements. */
const taxaByQid = new Map();
/** qid → finding id, so a row can address its own endpoints. */
const idByQid = new Map();

function escapeHtml(s) {
    return (s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function commonsCategoryUrl(name) {
    return `https://commons.wikimedia.org/w/index.php?title=Category:${encodeURIComponent(name).replace(/%20/g, '_')}&action=edit`;
}

function galleryUrl(t) {
    const q = new URLSearchParams({ taxon_id: t.inatTaxonId || '', name: t.taxonName || '', qid: t.qid || '' });
    return `taxon.html?${q}`;
}

function rowHtml(t) {
    const inatCell = t.inatTaxonId
        ? `<a href="${escapeHtml(INAT_OBS(t.inatTaxonId))}" target="_blank">${escapeHtml(t.inatTaxonId)}</a>`
        : '—';
    const commonsCell = t.taxonName
        ? `<a href="${escapeHtml(commonsCategoryUrl(t.taxonName))}" target="_blank">${escapeHtml(t.taxonName)}</a>`
        : '—';
    const photosCell = t.inatTaxonId
        ? `<a class="photos-btn" href="${escapeHtml(galleryUrl(t))}" target="_blank">View photos ↗</a>`
        : '—';

    // No inline onclick/onchange: the CSP forbids event-handler attributes (script-src-attr
    // 'none'), and this table is built from server data with innerHTML. Rows carry data-qid and
    // data-id, and #tbody delegates every event.
    return `<tr id="row-${escapeHtml(t.qid)}" data-qid="${escapeHtml(t.qid)}" data-id="${t.id}">
      <td class="check-col">
        <button class="confirm-btn" title="Check live Wikidata for the image and the Commons category">Confirm</button>
        <button class="skip-btn" title="Never offer this taxon again">Skip</button>
      </td>
      <td class="wd-col"><a href="${escapeHtml(t.wdUri)}" target="_blank">${escapeHtml(t.qid)}</a></td>
      <td class="inat-col">${inatCell}</td>
      <td class="commons-col">${commonsCell}</td>
      <td class="photos-col">${photosCell}</td>
      <td class="draft-col">
        <pre class="draft">${escapeHtml(t.wikitext)}</pre>
        <span class="hint">Copied!</span>
        <span class="row-msg"></span>
      </td>
    </tr>`;
}

// ---- copy helper (browser-side reimplementation of htmlShared.js) ----
function copyDraft(el) {
    const text = el.textContent;
    const hint = el.nextElementSibling;
    const show = () => { hint.style.display = 'inline'; setTimeout(() => { hint.style.display = 'none'; }, 1500); };
    if (navigator.clipboard) navigator.clipboard.writeText(text).then(show);
    else { const ta = document.createElement('textarea'); ta.value = text; document.body.appendChild(ta); ta.select(); document.execCommand('copy'); document.body.removeChild(ta); show(); }
}

let hidingDone = localStorage.getItem('hide-done') === '1';

const rows = () => document.querySelectorAll('#tbody tr[data-qid]');
const rowFor = (qid) => document.getElementById('row-' + qid);

function toggleHideDone() {
    hidingDone = !hidingDone;
    localStorage.setItem('hide-done', hidingDone ? '1' : '');
    $('hide-done').textContent = hidingDone ? 'Show done' : 'Hide done';
    document.querySelectorAll('tr.done').forEach((row) => row.classList.toggle('hide-done', hidingDone));
}

/** Why a confirm did not succeed, in words that say what to do about it. */
const REASONS = {
    missing_p18: 'No image on Wikidata yet — has the QuickStatements batch run?',
    missing_sitelink: 'Image is live, but the Commons category sitelink is still missing.',
    missing_p18_and_sitelink: 'Neither statement is live yet.',
    gone: 'This Wikidata item has been deleted or merged away.',
    not_found: 'This finding is no longer in the backlog — reload.',
};

function applyResult(result) {
    const row = rowFor(result.qid);
    if (!row) return;
    const msg = row.querySelector('.row-msg');

    if (result.confirmed) {
        row.classList.add('done');
        if (hidingDone) row.classList.add('hide-done');
        msg.textContent = 'Confirmed — it will leave the backlog on reload.';
        msg.className = 'row-msg ok';
        return;
    }
    row.classList.remove('done', 'hide-done');
    msg.textContent = REASONS[result.reason] ?? result.reason;
    msg.className = 'row-msg warn';
}

async function confirmIds(ids) {
    if (ids.length === 0) return [];
    try {
        const { results } = await postJson('api/findings/confirm', { ids });
        results.forEach(applyResult);
        refreshQuickStatements();
        return results;
    } catch (e) {
        $('status').textContent = `Could not confirm: ${e.message}`;
        return [];
    }
}

async function skipRow(row) {
    const id = Number(row.dataset.id);
    try {
        await postJson(`api/findings/${id}/skip`, {});
        row.classList.add('done');
        if (hidingDone) row.classList.add('hide-done');
        row.querySelector('.row-msg').textContent = 'Skipped — it will not be offered again.';
        row.querySelector('.row-msg').className = 'row-msg ok';
        refreshQuickStatements();
    } catch (e) {
        $('status').textContent = `Could not skip: ${e.message}`;
    }
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
    const results = await confirmIds(ids);
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
        const results = await confirmIds(res.toConfirm);
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

// ---- topping up the backlog ----
// A run takes minutes in a forked child on the server, so this starts one and then polls: no
// long-lived connection to keep alive, and a reload or a second tab picks up a run in progress.
let poller = null;

/** Human-readable progress. The counts differ per phase, so each says only what it knows. */
function describe(s) {
    if (s.state === 'running') {
        const c = s.counts ?? {};
        if (s.phase === 'querying') return 'Asking Wikidata which taxa still need an image…';
        if (s.phase === 'checking') {
            return c.batches
                ? `Checking iNaturalist for photos — batch ${c.batch} of ${c.batches}, ${c.matched ?? 0} with photos so far.`
                : `Checking ${c.taxa ?? '…'} taxa against iNaturalist…`;
        }
        if (s.phase === 'recording') return `Recording batch ${c.batch} of ${c.batches} — ${c.open ?? 0} to work on so far.`;
        return 'Starting…';
    }
    if (s.state === 'done') return `Done: ${s.counts?.open ?? 0} new taxa to work on. Reloading…`;
    if (s.state === 'cancelled') return `Cancelled — ${s.counts?.open ?? 0} found before stopping. Reloading…`;
    if (s.state === 'error') return `Failed: ${s.error?.message ?? 'unknown error'}`;
    return '';
}

function renderTopup(s) {
    $('topup').hidden = !s.enabled;
    const running = s.state === 'running';
    $('topup-run').disabled = running;
    $('topup-cancel').hidden = !running;
    $('topup-msg').textContent = describe(s);
    return running;
}

async function pollTopup() {
    try {
        const s = await getJson('api/discover/status');
        if (!renderTopup(s)) {
            clearInterval(poller);
            poller = null;
            // The table is a snapshot of the backlog, and the run just changed it.
            if (s.state === 'done' || s.state === 'cancelled') setTimeout(() => location.reload(), 1200);
        }
    } catch {
        // A poll that fails is not worth a message of its own; the next one usually works.
    }
}

function watchTopup() {
    if (poller) return;
    poller = setInterval(pollTopup, 2000);
    pollTopup();
}

async function startTopup() {
    const body = { limit: Number($('topup-limit').value) || 200 };
    const taxon = $('topup-taxon').value.trim();
    const iucn = $('topup-iucn').value;
    if (taxon) body.taxon = taxon;
    if (iucn) body.iucn = iucn;

    $('topup-run').disabled = true;
    $('topup-msg').textContent = 'Starting…';
    try {
        await postJson('api/discover', body);
        watchTopup();
    } catch (e) {
        $('topup-run').disabled = false;
        $('topup-msg').textContent = e.message;
    }
}

async function cancelTopup() {
    try {
        const s = await getJson('api/discover/status');
        await postJson('api/discover/cancel', s.runId ? { runId: s.runId } : {});
        $('topup-msg').textContent = 'Stopping — the taxa already checked are kept.';
    } catch (e) {
        $('topup-msg').textContent = e.message;
    }
}

// ---- wiring ----
$('download-uploaded').addEventListener('click', downloadUploaded);
$('qs-copy').addEventListener('click', copyQuickStatements);
$('qs-confirm').addEventListener('click', confirmPending);
$('hide-done').addEventListener('click', toggleHideDone);
$('import-run').addEventListener('click', () => runImport([...idByQid.keys()]));
$('topup-run').addEventListener('click', startTopup);
$('topup-cancel').addEventListener('click', cancelTopup);

// Delegated on #tbody, so rows rendered later need no wiring of their own.
$('tbody').addEventListener('click', async (e) => {
    const row = e.target.closest('tr[data-qid]');
    if (row && e.target.matches('.confirm-btn')) {
        e.target.disabled = true;
        row.querySelector('.row-msg').textContent = 'Checking Wikidata…';
        await confirmIds([Number(row.dataset.id)]);
        e.target.disabled = false;
        return;
    }
    if (row && e.target.matches('.skip-btn')) return skipRow(row);

    const draft = e.target.closest('.draft');
    if (draft) copyDraft(draft);
});

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
        $('tbody').innerHTML = taxa.map(rowHtml).join('\n');
        if (hidingDone) $('hide-done').textContent = 'Show done';
        if (taxa.length === 0) {
            $('status').textContent = 'Nothing open in the backlog. Run `node checkImages.js` to find more taxa.';
        }
        refreshUploadedCount();
        refreshQuickStatements();
        offerImport([...idByQid.keys()]);
        // Adopts a run started in another tab, or before a reload.
        pollTopup().then(() => { if ($('topup-run').disabled) watchTopup(); });
    } catch (e) {
        $('status').textContent = `Could not load the backlog from the server (${e.message}). Is \`npm run web\` still running?`;
    }
}

load();
