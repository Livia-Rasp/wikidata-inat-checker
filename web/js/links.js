// The links worklist: open matches ready to confirm, plus a review section for ambiguous names
// (one Wikidata item, several same-named iNat taxa) and conflicts (the matched iNat id is already
// claimed by a different Wikidata item) — the "candidates side by side with the evidence that
// distinguishes them" the roadmap's ambiguous-match wishlist asked for, replacing the static
// output/links-ambiguous.html + output/inat-links-conflicts.json nothing in the app used to read.
//
// The worklist half reuses rows.js's createRowTable exactly as index.html does. The review half is
// new: no equivalent existed anywhere in the app before this.

import { getJson, postJson } from './api.js';
import { createRowTable, escapeHtml } from './rows.js';
import { createPager, PAGE_SIZE } from './pager.js';
import { mountShell } from './shell.js';
import { clientId } from './clientId.js';

mountShell('link');

const $ = (id) => /** @type {HTMLElement} */ (document.getElementById(id));

let hidingDone = localStorage.getItem('hide-done-links') === '1';
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
    localStorage.setItem('hide-done-links', hidingDone ? '1' : '');
    $('hide-done').textContent = hidingDone ? 'Show done' : 'Hide done';
    document.querySelectorAll('#tbody tr.done').forEach((row) => row.classList.toggle('hide-done', hidingDone));
}

// ---- QuickStatements panel: open matches that clear the --auto bar ----
// Unlike images, a link finding needs no per-taxon pick — the proposed inatId is fixed at
// discovery time — so this is simply every open, autoEligible finding, fetched independently of
// the paged worklist above (the same reason images' pendingQs() doesn't read the visible page).

/** Above the API's page-size ceiling but within its MAX_LIMIT, so one request is the whole
 *  practical backlog — an ambiguous-match-sized bucket, not the millions the taxa index holds. */
const QS_FETCH_LIMIT = 2000;

async function autoEligibleOpen() {
    const { taxa } = await getJson(
        `api/findings?kind=link&status=open&limit=${QS_FETCH_LIMIT}&clientId=${encodeURIComponent(clientId())}`);
    return taxa.filter((t) => t.payload?.autoEligible === true);
}

function qsLines(pending) {
    return pending.map((t) => `${t.qid}\tP3151\t"${t.inatTaxonId}"`).join('\n');
}

async function refreshQuickStatements() {
    const pending = await autoEligibleOpen();
    const qsText = /** @type {HTMLTextAreaElement} */ ($('qs-text'));
    qsText.value = qsLines(pending);
    $('qs-count').textContent = pending.length ? `${pending.length} taxa` : '';
    /** @type {HTMLButtonElement} */ ($('qs-copy')).disabled = pending.length === 0;
    /** @type {HTMLButtonElement} */ ($('qs-confirm')).disabled = pending.length === 0;
    qsText.dataset.ids = JSON.stringify(pending.map((t) => t.id));
}

function copyQuickStatements() {
    const qsText = /** @type {HTMLTextAreaElement} */ ($('qs-text'));
    const text = qsText.value;
    if (!text) return;
    const done = () => { $('qs-hint').textContent = 'Copied. Run the batch, then Confirm pending.'; };
    if (navigator.clipboard) navigator.clipboard.writeText(text).then(done);
    else { qsText.select(); document.execCommand('copy'); done(); }
}

async function confirmPending() {
    const ids = JSON.parse($('qs-text').dataset.ids || '[]');
    const results = await table.confirm(ids);
    const ok = results.filter((r) => r.confirmed).length;
    $('qs-hint').textContent = results.length ? `${ok} of ${results.length} confirmed.` : 'Nothing to confirm.';
    await Promise.all([loadWorklist(), refreshQuickStatements()]);
}

// ---- review: ambiguous names and conflicts, one comparison table per candidate ----
// Ported from report/htmlShared.js's renderTreePair, not imported: web/ has no build step and
// cannot pull in lib/utils.js's Node-only dependencies (wikibase-sdk, fs), the same reason
// web/js/enrich.js duplicates rather than imports its Commons-category caching.

const WD_RANK_LABELS = {
    Q34740: 'genus', Q35409: 'family', Q2136103: 'superfamily',
    Q164280: 'subfamily', Q227936: 'tribe', Q3965313: 'subtribe',
    Q36602: 'order', Q5867051: 'subclass', Q37517: 'class',
};
const RANK_ORDER = [
    'kingdom', 'subkingdom', 'phylum', 'subphylum',
    'superclass', 'class', 'subclass',
    'superorder', 'order', 'suborder', 'infraorder',
    'superfamily', 'family', 'subfamily',
    'supertribe', 'tribe', 'subtribe',
    'genus', 'subgenus', 'section', 'subsection',
    'species', 'subspecies', 'variety',
];

function treePairHtml(wdChain, inatChain) {
    const wdByRank = new Map((wdChain ?? [])
        .filter((e) => e.rankQid && WD_RANK_LABELS[e.rankQid])
        .map((e) => [WD_RANK_LABELS[e.rankQid], e.name]));
    const inatByRank = new Map((inatChain ?? [])
        .filter((e) => e.rank)
        .map((e) => [e.rank.toLowerCase(), e.name]));

    const allRanks = [...new Set([...wdByRank.keys(), ...inatByRank.keys()])];
    allRanks.sort((a, b) => {
        const ai = RANK_ORDER.indexOf(a), bi = RANK_ORDER.indexOf(b);
        if (ai === -1 && bi === -1) return 0;
        if (ai === -1) return 1;
        if (bi === -1) return -1;
        return ai - bi;
    });
    if (allRanks.length === 0) return '<span class="no-tree">—</span>';

    return '<table class="tree-pair">' + allRanks.map((rank) => {
        const wdName = wdByRank.get(rank) ?? '';
        const inatName = inatByRank.get(rank) ?? '';
        let cls = '';
        if (wdName && inatName) {
            cls = wdName.toLowerCase() === inatName.toLowerCase() ? ' class="tree-match"' : ' class="tree-mismatch"';
        }
        const label = rank[0].toUpperCase() + rank.slice(1);
        return `<tr${cls}><td class="tp-rank">${escapeHtml(label)}</td>`
            + `<td class="tp-wd">${wdName ? escapeHtml(wdName) : '<span class="absent">—</span>'}</td>`
            + `<td class="tp-inat">${inatName ? escapeHtml(inatName) : '<span class="absent">—</span>'}</td></tr>`;
    }).join('') + '</table>';
}

const INAT_TAXON = (id) => `https://www.inaturalist.org/taxa/${id}`;

function ambiguousGroupHtml(f) {
    const { wdChain, candidates } = f.payload;
    const rows = candidates.map((c) => `
        <div class="review-candidate" data-inat-id="${escapeHtml(c.inatId)}">
          <div class="inat-col"><a href="${escapeHtml(INAT_TAXON(c.inatId))}" target="_blank">${escapeHtml(c.inatId)}</a>
            <span class="rank-badge">${escapeHtml(c.rank ?? '')}</span></div>
          <div>${treePairHtml(wdChain, c.inatChain)}</div>
          <pre class="qs">${escapeHtml(`${f.qid}\tP3151\t"${c.inatId}"`)}</pre>
          <div>
            <button type="button" class="pick-btn">Pick this one</button>
            <div class="review-msg"></div>
          </div>
        </div>`).join('');
    return `
      <div class="review-group" id="review-${escapeHtml(f.qid)}" data-id="${f.id}" data-review-kind="ambiguous">
        <div class="review-head">
          <span class="wd-col"><a href="${escapeHtml(f.wdUri)}" target="_blank">${escapeHtml(f.qid)}</a></span>
          <span class="review-taxon">${escapeHtml(f.taxonName ?? '')}</span>
          <span class="review-type">ambiguous — ${candidates.length} candidates</span>
        </div>
        <div class="review-candidates">${rows}</div>
      </div>`;
}

function conflictGroupHtml(f) {
    const { wdChain, inatChain, existingWdItem, existingTaxonName } = f.payload;
    return `
      <div class="review-group" id="review-${escapeHtml(f.qid)}" data-id="${f.id}" data-review-kind="conflict">
        <div class="review-head">
          <span class="wd-col"><a href="${escapeHtml(f.wdUri)}" target="_blank">${escapeHtml(f.qid)}</a></span>
          <span class="review-taxon">${escapeHtml(f.taxonName ?? '')}</span>
          <span class="review-type review-conflict">conflict — already claimed by
            <a href="https://www.wikidata.org/entity/${escapeHtml(existingWdItem)}" target="_blank">${escapeHtml(existingWdItem)}</a>
            (${escapeHtml(existingTaxonName ?? '')})</span>
        </div>
        <div class="review-candidates">
          <div class="review-candidate" data-inat-id="${escapeHtml(f.inatTaxonId ?? '')}">
            <div class="inat-col"><a href="${escapeHtml(INAT_TAXON(f.inatTaxonId))}" target="_blank">${escapeHtml(f.inatTaxonId ?? '')}</a></div>
            <div>${treePairHtml(wdChain, inatChain)}</div>
            <div></div>
            <div>
              <button type="button" class="skip-btn" data-id="${f.id}">Skip</button>
              <div class="review-msg"></div>
            </div>
          </div>
        </div>
      </div>`;
}

let reviewCount = 0;

async function loadReview() {
    const [ambiguous, conflict] = await Promise.all([
        getJson(`api/findings?kind=link&status=ambiguous&limit=${QS_FETCH_LIMIT}`),
        getJson(`api/findings?kind=link&status=conflict&limit=${QS_FETCH_LIMIT}`),
    ]);
    reviewCount = ambiguous.taxa.length + conflict.taxa.length;
    $('review-count').textContent = reviewCount ? `(${reviewCount})` : '';
    $('review-list').innerHTML = reviewCount === 0
        ? '<p class="muted">Nothing needs review right now.</p>'
        : [...ambiguous.taxa.map(ambiguousGroupHtml), ...conflict.taxa.map(conflictGroupHtml)].join('\n');
}

async function pickCandidate(groupEl, inatId) {
    const id = Number(groupEl.dataset.id);
    const candidateEl = groupEl.querySelector(`.review-candidate[data-inat-id="${CSS.escape(inatId)}"]`);
    const msg = candidateEl.querySelector('.review-msg');
    try {
        await postJson(`api/findings/${id}/pick`, { inatId });
        msg.textContent = 'Picked — moved to the worklist above.';
        msg.className = 'review-msg ok';
        groupEl.remove();
        $('review-count').textContent = --reviewCount ? `(${reviewCount})` : '';
        await Promise.all([loadWorklist(), refreshQuickStatements()]);
    } catch (e) {
        msg.textContent = `Could not pick: ${e.message}`;
        msg.className = 'review-msg warn';
    }
}

// A conflict candidate's Skip is a much rarer path than the main worklist's (one competing claim,
// not "every tester"), and this group is removed from the DOM outright on skip — so unlike
// rows.js's skip(), there is no inline Undo here; reversing one means reloading the review section.
async function skipReviewRow(groupEl, id) {
    const msg = groupEl.querySelector('.review-msg');
    try {
        const result = await postJson(`api/findings/${id}/skip`, { clientId: clientId() });
        msg.textContent = result.status === 'skipped'
            ? 'Skipped — it will not be offered again.'
            : 'Skipped for you — still open for other testers.';
        msg.className = 'review-msg ok';
        groupEl.remove();
        $('review-count').textContent = --reviewCount ? `(${reviewCount})` : '';
    } catch (e) {
        msg.textContent = `Could not skip: ${e.message}`;
        msg.className = 'review-msg warn';
    }
}

// ---- worklist loading ----

async function loadWorklist() {
    try {
        const data = await getJson(
            `api/findings?kind=link&status=open&limit=${PAGE_SIZE}&offset=${offset}&clientId=${encodeURIComponent(clientId())}`);
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

$('review-list').addEventListener('click', (e) => {
    const target = /** @type {HTMLElement} */ (e.target);
    const pick = target.closest('.pick-btn');
    if (pick) {
        const candidateEl = /** @type {HTMLElement} */ (pick.closest('.review-candidate'));
        const groupEl = pick.closest('.review-group');
        return pickCandidate(groupEl, candidateEl.dataset.inatId);
    }
    const skip = target.closest('.skip-btn');
    if (skip) return skipReviewRow(skip.closest('.review-group'), Number(/** @type {HTMLElement} */ (skip).dataset.id));

    // Copy-on-click for a candidate's QuickStatements line — same behaviour as the worklist's
    // .draft cells, ported here since review rows use a plain .qs pre, not createRowTable's markup.
    const qs = target.closest('.qs');
    if (qs) {
        const text = qs.textContent;
        if (navigator.clipboard) navigator.clipboard.writeText(text);
        else { const r = document.createRange(); r.selectNodeContents(qs); getSelection()?.removeAllRanges(); getSelection()?.addRange(r); document.execCommand('copy'); }
    }
});

// ---- boot ----
loadWorklist();
refreshQuickStatements();
loadReview();
