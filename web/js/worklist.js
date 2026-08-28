// Shared controller for the three backlog "worklist" pages (index.html/main.js, links.html/
// links.js, names.html/names.js): a paged table of open findings with a hide-done toggle and a
// QuickStatements copy/confirm panel. Configured per kind rather than duplicated — the way
// search.js keys its <thead> by kind via THEAD_HTML — since the three pages' toggle/load/copy/
// confirm logic was otherwise near-byte-identical, differing only in the kind, the localStorage
// key, and the QuickStatements panel's data source, line format and label text.
import { createRowTable } from './rows.js';
import { createPager, PAGE_SIZE } from './pager.js';
import { clientId } from './clientId.js';

const $ = (id) => /** @type {HTMLElement} */ (document.getElementById(id));

/**
 * Fill the QS panel's inner markup from config into its otherwise-empty `<section id="qs-panel">`
 * mount point — the one part of the three pages' HTML that was pure copy-paste (identical ids;
 * only the label suffix and the textarea's placeholder text differed). The placeholder is set as
 * a DOM property, not interpolated into the HTML string, so it needs no escaping.
 * @param {HTMLElement} el
 * @param {{qsLabel: string, qsPlaceholder: string}} opts
 */
function renderQsPanel(el, { qsLabel, qsPlaceholder }) {
    el.innerHTML = `
      <div class="qs-head">
        <strong>QuickStatements</strong>${qsLabel ? ` — ${qsLabel}` : ''}
        <span id="qs-count" class="muted"></span>
        <button id="qs-copy" disabled>Copy</button>
        <button id="qs-confirm" disabled>Confirm pending</button>
        <span id="qs-hint" class="muted"></span>
      </div>
      <textarea id="qs-text" readonly></textarea>`;
    /** @type {HTMLTextAreaElement} */ (el.querySelector('#qs-text')).placeholder = qsPlaceholder;
}

/**
 * @param {{
 *   kind: 'image'|'link'|'name',
 *   hideDoneKey: string,
 *   postJson: (path: string, body?: object) => Promise<any>,
 *   getJson: (path: string) => Promise<any>,
 *   qsLabel?: string,
 *   qsPlaceholder: string,
 *   fetchPending: () => Promise<any[]>|any[],
 *   qsLines: (pending: any[]) => string,
 *   idsOf: (pending: any[]) => number[],
 *   confirmMessage: (ok: number, total: number) => string,
 *   qsCountText?: (pending: any[]) => string,
 *   extraFetch?: () => Promise<any>,
 *   onLoaded?: () => void,
 * }} config
 */
export function createWorklistPage(config) {
    const {
        kind, hideDoneKey, postJson, getJson,
        qsLabel = '', qsPlaceholder,
        fetchPending, qsLines, idsOf, confirmMessage,
        qsCountText = (pending) => (pending.length ? `${pending.length} taxa` : ''),
        extraFetch = async () => {},
        onLoaded = () => {},
    } = config;

    renderQsPanel($('qs-panel'), { qsLabel, qsPlaceholder });

    let hidingDone = localStorage.getItem(hideDoneKey) === '1';
    let offset = 0;

    const table = createRowTable({
        tbody: $('tbody'), postJson,
        hidingDone: () => hidingDone,
        onStatus: (msg) => { $('status').textContent = msg; },
        onChange: refreshQuickStatements,
    });

    const pager = createPager({
        el: $('pager'), scrollTo: $('controls'),
        onPage: (to) => { offset = to; load(); },
    });

    function toggleHideDone() {
        hidingDone = !hidingDone;
        localStorage.setItem(hideDoneKey, hidingDone ? '1' : '');
        $('hide-done').textContent = hidingDone ? 'Show done' : 'Hide done';
        document.querySelectorAll('#tbody tr.done').forEach((row) => row.classList.toggle('hide-done', hidingDone));
    }

    async function refreshQuickStatements() {
        const pending = await fetchPending();
        /** @type {HTMLTextAreaElement} */ ($('qs-text')).value = qsLines(pending);
        $('qs-count').textContent = qsCountText(pending);
        /** @type {HTMLButtonElement} */ ($('qs-copy')).disabled = pending.length === 0;
        /** @type {HTMLButtonElement} */ ($('qs-confirm')).disabled = pending.length === 0;
    }

    function copyQuickStatements() {
        const qsText = /** @type {HTMLTextAreaElement} */ ($('qs-text'));
        const text = qsText.value;
        if (!text) return;
        const done = () => { $('qs-hint').textContent = 'Copied. Run the batch, then Confirm pending.'; };
        if (navigator.clipboard) navigator.clipboard.writeText(text).then(done);
        else { qsText.select(); document.execCommand('copy'); done(); }
    }

    /** Always re-fetches pending fresh rather than trusting a stale snapshot from the last
     *  refreshQuickStatements() call — matching main.js's original, more-correct behavior (the
     *  other two pages used to cache ids in the textarea's dataset instead), now shared by all
     *  three pages. */
    async function confirmPending() {
        const pending = await fetchPending();
        const results = await table.confirm(idsOf(pending));
        const ok = results.filter((r) => r.confirmed).length;
        $('qs-hint').textContent = results.length ? confirmMessage(ok, results.length) : 'Nothing to confirm.';
        await Promise.all([load(), refreshQuickStatements()]);
    }

    async function load() {
        try {
            const [data] = await Promise.all([
                getJson(`api/findings?kind=${kind}&status=open&limit=${PAGE_SIZE}&offset=${offset}&clientId=${encodeURIComponent(clientId())}`),
                extraFetch(),
            ]);
            const taxa = data.taxa || [];

            // A page that has run out — the last rows of the last page confirmed away, say — falls
            // back to the last page that still exists rather than showing an empty table.
            const fallback = pager.fallbackOffset(data);
            if (fallback !== null) { offset = fallback; return load(); }

            $('count').textContent = taxa.length < data.total
                ? `${data.total} taxa — showing ${offset + 1}–${offset + taxa.length}`
                : `${data.total} taxa`;
            if (data.generated) $('generated').textContent = `backlog as of ${new Date(data.generated).toLocaleString()}`;
            table.render(taxa);
            pager.render(data);
            if (hidingDone) $('hide-done').textContent = 'Show done';
            if (data.total === 0) {
                $('status').textContent = 'Nothing open in the backlog. Search for a clade to find more.';
            }
            onLoaded();
            return data;
        } catch (e) {
            $('status').textContent = `Could not load the backlog from the server (${e.message}). Is \`npm run web\` still running?`;
        }
    }

    $('qs-copy').addEventListener('click', copyQuickStatements);
    $('qs-confirm').addEventListener('click', confirmPending);
    $('hide-done').addEventListener('click', toggleHideDone);

    return { table, pager, load, refreshQuickStatements, toggleHideDone };
}
