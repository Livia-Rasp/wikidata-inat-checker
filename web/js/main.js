// Main view: loads the open image backlog from the server's /api/findings and
// renders a drafts.html-like table of image-less taxa. Each row links out to Wikidata,
// the iNat taxon, and the Commons category, shows the draft Wikitext (click to copy),
// and opens the per-taxon photo gallery in a new tab.

import { uploaded, p18 } from './cache.js';

const $ = (id) => document.getElementById(id);
const INAT_OBS = (id) =>
    `https://www.inaturalist.org/observations?taxon_id=${id}&photo_license=cc0%2Ccc-by%2Ccc-by-sa&quality_grade=research`;

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
    // #tbody delegates both events.
    return `<tr id="row-${escapeHtml(t.qid)}" data-qid="${escapeHtml(t.qid)}">
      <td class="check-col"><input type="checkbox" class="done-cb"></td>
      <td class="wd-col"><a href="${escapeHtml(t.wdUri)}" target="_blank">${escapeHtml(t.qid)}</a></td>
      <td class="inat-col">${inatCell}</td>
      <td class="commons-col">${commonsCell}</td>
      <td class="photos-col">${photosCell}</td>
      <td class="draft-col">
        <pre class="draft">${escapeHtml(t.wikitext)}</pre>
        <span class="hint">Copied!</span>
      </td>
    </tr>`;
}

// ---- copy + done helpers (browser-side reimplementation of htmlShared.js) ----
function copyDraft(el) {
    const text = el.textContent;
    const hint = el.nextElementSibling;
    const show = () => { hint.style.display = 'inline'; setTimeout(() => { hint.style.display = 'none'; }, 1500); };
    if (navigator.clipboard) navigator.clipboard.writeText(text).then(show);
    else { const ta = document.createElement('textarea'); ta.value = text; document.body.appendChild(ta); ta.select(); document.execCommand('copy'); document.body.removeChild(ta); show(); }
}

let hidingDone = localStorage.getItem('hide-done') === '1';

function setDone(qid, done) {
    localStorage.setItem('done-' + qid, done ? '1' : '');
    const row = $('row-' + qid);
    row.classList.toggle('done', done);
    if (done && hidingDone) row.classList.add('hide-done');
    if (!done) row.classList.remove('hide-done');
    refreshQuickStatements(); // a done taxon with a picked P18 image gates into the panel
}

function toggleHideDone() {
    hidingDone = !hidingDone;
    localStorage.setItem('hide-done', hidingDone ? '1' : '');
    $('hide-done').textContent = hidingDone ? 'Show done' : 'Hide done';
    document.querySelectorAll('tr.done').forEach((row) => row.classList.toggle('hide-done', hidingDone));
}

/** Every rendered row, paired with its qid — the single place the DOM↔qid mapping is read. */
const rows = () => document.querySelectorAll('#tbody tr[data-qid]');

function restoreState() {
    rows().forEach((row) => {
        if (!localStorage.getItem('done-' + row.dataset.qid)) return;
        row.querySelector('.done-cb').checked = true;
        row.classList.add('done');
        if (hidingDone) row.classList.add('hide-done');
    });
    if (hidingDone) $('hide-done').textContent = 'Show done';
}

// ---- QuickStatements panel: P18 image + Commons-category sitelink ----
// A taxon contributes two commands once it is both marked done and has a picked P18 image
// (chosen in its gallery tab). Copying flushes the included picks so each edit runs only once.
const taxaByQid = new Map();

function pendingQs() {
    return Object.entries(p18.all())
        .filter(([qid]) => localStorage.getItem('done-' + qid))
        .map(([qid, { file, category }]) => ({
            qid,
            file,
            category: category || taxaByQid.get(qid) || '',
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
}

function copyQuickStatements() {
    const pending = pendingQs();
    if (pending.length === 0) return;
    const text = qsLines(pending);
    const flush = () => {
        pending.forEach((q) => p18.clear(q.qid));
        refreshQuickStatements();
    };
    if (navigator.clipboard) navigator.clipboard.writeText(text).then(flush);
    else {
        const ta = $('qs-text');
        ta.select();
        document.execCommand('copy');
        flush();
    }
}

// Re-read done flags from localStorage onto the rows — picks made in a gallery tab auto-mark
// the taxon done, so the checkbox/row must catch up when the main view regains focus.
function syncDoneState() {
    rows().forEach((row) => {
        const done = !!localStorage.getItem('done-' + row.dataset.qid);
        row.querySelector('.done-cb').checked = done;
        row.classList.toggle('done', done);
        row.classList.toggle('hide-done', done && hidingDone);
    });
}

// ---- uploaded-files backfill list: download button + count (§7.2) ----
function refreshUploadedCount() {
    const n = uploaded.count();
    $('uploaded-count').textContent = n ? `${n} marked uploaded` : '';
}

function downloadUploaded() {
    const blob = new Blob([JSON.stringify(uploaded.exportObject(), null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'uploaded-files.json';
    a.click();
    URL.revokeObjectURL(a.href);
}

$('download-uploaded').addEventListener('click', downloadUploaded);
$('qs-copy').addEventListener('click', copyQuickStatements);
$('hide-done').addEventListener('click', toggleHideDone);

// Delegated on #tbody, so rows rendered later need no wiring of their own.
$('tbody').addEventListener('change', (e) => {
    const row = e.target.closest('tr[data-qid]');
    if (row && e.target.matches('.done-cb')) setDone(row.dataset.qid, e.target.checked);
});
$('tbody').addEventListener('click', (e) => {
    const draft = e.target.closest('.draft');
    if (draft) copyDraft(draft);
});

refreshUploadedCount();
// Refresh after marking/picking in a gallery tab (which may auto-mark a taxon done).
window.addEventListener('focus', () => {
    refreshUploadedCount();
    syncDoneState();
    refreshQuickStatements();
});

// The URL is relative, like every other path here, so the app still works mounted under a
// reverse-proxy subpath. limit is the API's ceiling: past that the backlog is reported as
// truncated rather than silently cut short.
const API = 'api/findings?kind=image&status=open&limit=2000';

async function load() {
    try {
        const r = await fetch(API, { cache: 'no-store' });
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const data = await r.json();
        const taxa = data.taxa || [];
        taxa.forEach((t) => { if (t.qid && t.taxonName) taxaByQid.set(t.qid, t.taxonName); });
        $('count').textContent = data.total > taxa.length
            ? `${taxa.length} of ${data.total} taxa`
            : `${taxa.length} taxa`;
        if (data.generated) $('generated').textContent = `backlog as of ${new Date(data.generated).toLocaleString()}`;
        $('tbody').innerHTML = taxa.map(rowHtml).join('\n');
        if (taxa.length === 0) {
            $('status').textContent = 'Nothing open in the backlog. Run `node checkImages.js` to find more taxa.';
        }
        restoreState();
        refreshQuickStatements();
    } catch (e) {
        $('status').textContent = `Could not load the backlog from the server (${e.message}). Is \`npm run web\` still running?`;
    }
}

load();
