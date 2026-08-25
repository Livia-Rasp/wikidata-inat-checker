// The names worklist: open findings ready to confirm — iNat vernacular names missing from
// Wikidata's P1843. No review section: unlike links, a name finding has no ambiguity to resolve —
// every candidate already carries a confirmed inatId from a P3151-linked WD item, so the only
// question is which languages are missing, not which iNat taxon is meant.
//
// The worklist half reuses rows.js's createRowTable exactly as index.html and links.html do.

import { getJson, postJson } from './api.js';
import { createRowTable, buildNameQuickStatements } from './rows.js';
import { createPager, PAGE_SIZE } from './pager.js';
import { mountShell } from './shell.js';

mountShell('name');

const $ = (id) => document.getElementById(id);

let hidingDone = localStorage.getItem('hide-done-names') === '1';
let offset = 0;

const table = createRowTable({
    tbody: $('tbody'),
    postJson,
    hidingDone: () => hidingDone,
    onStatus: (msg) => { $('status').textContent = msg; },
    onChange: refreshQuickStatements,
});

const pager = createPager({
    el: $('pager'),
    scrollTo: $('controls'),
    onPage: (to) => { offset = to; loadWorklist(); },
});

function toggleHideDone() {
    hidingDone = !hidingDone;
    localStorage.setItem('hide-done-names', hidingDone ? '1' : '');
    $('hide-done').textContent = hidingDone ? 'Show done' : 'Hide done';
    document.querySelectorAll('#tbody tr.done').forEach((row) => row.classList.toggle('hide-done', hidingDone));
}

// ---- QuickStatements panel: every open finding, batched ----
// Unlike links' auto-eligible subset (a taxonomic-confidence bar), a name finding has no
// confidence axis to gate on — every candidate's iNat match is already certain, so the panel
// simply batches every open finding, fetched independently of the paged worklist above.

/** Above the API's page-size ceiling but within its MAX_LIMIT, so one request is the whole
 *  practical backlog. */
const QS_FETCH_LIMIT = 2000;

async function pendingOpen() {
    const { taxa } = await getJson(`api/findings?kind=name&status=open&limit=${QS_FETCH_LIMIT}`);
    return taxa;
}

function qsLines(pending) {
    return pending
        .filter((t) => t.inatTaxonId && t.payload?.missing?.length)
        .map((t) => buildNameQuickStatements(t.qid, t.inatTaxonId, t.payload.missing))
        .join('\n');
}

async function refreshQuickStatements() {
    const pending = await pendingOpen();
    $('qs-text').value = qsLines(pending);
    $('qs-count').textContent = pending.length ? `${pending.length} taxa` : '';
    $('qs-copy').disabled = pending.length === 0;
    $('qs-confirm').disabled = pending.length === 0;
    $('qs-text').dataset.ids = JSON.stringify(pending.map((t) => t.id));
}

function copyQuickStatements() {
    const text = $('qs-text').value;
    if (!text) return;
    const done = () => { $('qs-hint').textContent = 'Copied. Run the batch, then Confirm pending.'; };
    if (navigator.clipboard) navigator.clipboard.writeText(text).then(done);
    else { $('qs-text').select(); document.execCommand('copy'); done(); }
}

async function confirmPending() {
    const ids = JSON.parse($('qs-text').dataset.ids || '[]');
    const results = await table.confirm(ids);
    const ok = results.filter((r) => r.confirmed).length;
    $('qs-hint').textContent = results.length ? `${ok} of ${results.length} fully confirmed.` : 'Nothing to confirm.';
    await Promise.all([loadWorklist(), refreshQuickStatements()]);
}

// ---- worklist loading ----

async function loadWorklist() {
    try {
        const data = await getJson(`api/findings?kind=name&status=open&limit=${PAGE_SIZE}&offset=${offset}`);
        const taxa = data.taxa || [];

        const fallback = pager.fallbackOffset(data);
        if (fallback !== null) { offset = fallback; return loadWorklist(); }

        $('count').textContent = taxa.length < data.total
            ? `${data.total} taxa — showing ${offset + 1}–${offset + taxa.length}`
            : `${data.total} taxa`;
        if (data.generated) $('generated').textContent = `backlog as of ${new Date(data.generated).toLocaleString()}`;
        table.render(taxa);
        pager.render(data);
        if (hidingDone) $('hide-done').textContent = 'Show done';
        if (data.total === 0) $('status').textContent = 'Nothing open in the backlog. Search for a clade to find more.';
    } catch (e) {
        $('status').textContent = `Could not load the backlog from the server (${e.message}). Is \`npm run web\` still running?`;
    }
}

// ---- wiring ----
$('qs-copy').addEventListener('click', copyQuickStatements);
$('qs-confirm').addEventListener('click', confirmPending);
$('hide-done').addEventListener('click', toggleHideDone);

// ---- boot ----
loadWorklist();
refreshQuickStatements();
