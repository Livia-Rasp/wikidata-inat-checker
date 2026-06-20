// Main view: loads the data contract (data/taxa.json) produced by checkImages.js and
// renders a drafts.html-like table of image-less taxa. Each row links out to Wikidata,
// the iNat taxon, and the Commons category, shows the draft Wikitext (click to copy),
// and opens the per-taxon photo gallery in a new tab.

import { uploaded } from './cache.js';

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

    return `<tr id="row-${t.qid}">
      <td class="check-col"><input type="checkbox" id="cb-${t.qid}" onchange="setDone('${t.qid}', this.checked)"></td>
      <td class="wd-col"><a href="${escapeHtml(t.wdUri)}" target="_blank">${escapeHtml(t.qid)}</a></td>
      <td class="inat-col">${inatCell}</td>
      <td class="commons-col">${commonsCell}</td>
      <td class="photos-col">${photosCell}</td>
      <td class="draft-col">
        <pre class="draft" onclick="copy(this)">${escapeHtml(t.wikitext)}</pre>
        <span class="hint">Copied!</span>
      </td>
    </tr>`;
}

// ---- copy + done helpers (browser-side reimplementation of htmlShared.js) ----
window.copy = function (el) {
    const text = el.textContent;
    const hint = el.nextElementSibling;
    const show = () => { hint.style.display = 'inline'; setTimeout(() => { hint.style.display = 'none'; }, 1500); };
    if (navigator.clipboard) navigator.clipboard.writeText(text).then(show);
    else { const ta = document.createElement('textarea'); ta.value = text; document.body.appendChild(ta); ta.select(); document.execCommand('copy'); document.body.removeChild(ta); show(); }
};

let hidingDone = localStorage.getItem('hide-done') === '1';

window.setDone = function (qid, done) {
    localStorage.setItem('done-' + qid, done ? '1' : '');
    const row = $('row-' + qid);
    row.classList.toggle('done', done);
    if (done && hidingDone) row.classList.add('hide-done');
    if (!done) row.classList.remove('hide-done');
};

window.toggleHideDone = function () {
    hidingDone = !hidingDone;
    localStorage.setItem('hide-done', hidingDone ? '1' : '');
    $('hide-done').textContent = hidingDone ? 'Show done' : 'Hide done';
    document.querySelectorAll('tr.done').forEach((row) => row.classList.toggle('hide-done', hidingDone));
};

function restoreState() {
    document.querySelectorAll('input[type=checkbox]').forEach((cb) => {
        const qid = cb.id.replace('cb-', '');
        if (localStorage.getItem('done-' + qid)) {
            cb.checked = true;
            const row = $('row-' + qid);
            row.classList.add('done');
            if (hidingDone) row.classList.add('hide-done');
        }
    });
    if (hidingDone) $('hide-done').textContent = 'Show done';
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
refreshUploadedCount();
window.addEventListener('focus', refreshUploadedCount); // refresh after marking in a gallery tab

async function load() {
    try {
        const r = await fetch('data/taxa.json', { cache: 'no-store' });
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const data = await r.json();
        const taxa = data.taxa || [];
        $('count').textContent = `${taxa.length} taxa`;
        if (data.generated) $('generated').textContent = `generated ${new Date(data.generated).toLocaleString()}`;
        $('tbody').innerHTML = taxa.map(rowHtml).join('\n');
        restoreState();
    } catch (e) {
        $('status').textContent = `Could not load data/taxa.json (${e.message}). Run \`node checkImages.js\` first.`;
    }
}

load();
