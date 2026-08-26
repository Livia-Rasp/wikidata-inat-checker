// One backlog row, rendered and wired the same way wherever it appears — the worklist on
// index.html and the search results on search.html. Extracted from main.js when the second page
// arrived; both pages must offer the same actions on a finding, or "search then work" turns into
// "search, go back to the list, find it again".
//
// Nothing here reaches for an element by id: the table is passed in. That is what lets two pages
// hold one of these each without their rows fighting over `document`.

const INAT_OBS = (id) =>
    `https://www.inaturalist.org/observations?taxon_id=${id}&photo_license=cc0%2Ccc-by%2Ccc-by-sa&quality_grade=research`;
const INAT_TAXON = (id) => `https://www.inaturalist.org/taxa/${id}`;

export function escapeHtml(s) {
    return (s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

export function commonsCategoryUrl(name) {
    return `https://commons.wikimedia.org/w/index.php?title=Category:${encodeURIComponent(name).replace(/%20/g, '_')}&action=edit`;
}

export function galleryUrl(t) {
    const q = new URLSearchParams({ taxon_id: t.inatTaxonId || '', name: t.taxonName || '', qid: t.qid || '' });
    return `taxon.html?${q}`;
}

/** The Red List's own category codes. Colours live in the stylesheet, as classes: the CSP forbids
 *  the inline `style=` the HTML reports use, and a class is the better answer anyway. */
const IUCN_CODES = new Set(['EX', 'EW', 'CR', 'EN', 'VU', 'NT', 'LC', 'DD', 'NE']);

export function iucnBadge(code) {
    if (!code || !IUCN_CODES.has(code)) return '—';
    return `<span class="iucn iucn-${code.toLowerCase()}">${escapeHtml(code)}</span>`;
}

/** Why a confirm did not succeed, in words that say what to do about it. */
export const REASONS = {
    missing_p18: 'No image on Wikidata yet — has the QuickStatements batch run?',
    missing_sitelink: 'Image is live, but the Commons category sitelink is still missing.',
    missing_p18_and_sitelink: 'Neither statement is live yet.',
    missing_p3151: 'No P3151 statement on Wikidata yet — has the QuickStatements line run?',
    missing_names: 'None of the proposed names are live on Wikidata yet — has the QuickStatements batch run?',
    partially_confirmed: 'Some of the proposed names are now live; the rest are still missing — reload to see which.',
    gone: 'This Wikidata item has been deleted or merged away.',
    not_found: 'This finding is no longer in the backlog — reload.',
};

function imageRowHtml(t) {
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
    // data-id, and the tbody delegates every event.
    return `<tr id="row-${escapeHtml(t.qid)}" data-qid="${escapeHtml(t.qid)}" data-id="${t.id}">
      <td class="check-col">
        <button class="confirm-btn" title="Check live Wikidata for the image and the Commons category">Confirm</button>
        <button class="skip-btn" title="Never offer this taxon again">Skip</button>
      </td>
      <td class="wd-col"><a href="${escapeHtml(t.wdUri)}" target="_blank">${escapeHtml(t.qid)}</a></td>
      <td class="iucn-col">${iucnBadge(t.iucn)}</td>
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

/** Same shell as imageRowHtml (id/data attrs, confirm/skip, a `.draft` copy cell), different
 *  columns — a link finding proposes one P3151 statement, not an image + Commons category, so
 *  there is no photos/gallery cell and the confidence badge replaces the Commons-category link. */
function linkRowHtml(t) {
    const inatId = t.inatTaxonId;
    const inatCell = inatId
        ? `<a href="${escapeHtml(INAT_TAXON(inatId))}" target="_blank">${escapeHtml(inatId)}</a>`
        : '—';
    const auto = t.payload?.autoEligible === true;
    const confidence = `<span class="confidence ${auto ? 'confidence-high' : 'confidence-low'}">`
        + `${auto ? 'high confidence' : 'check taxonomy'}</span>`;
    const qs = inatId ? `${t.qid}\tP3151\t"${inatId}"` : '';

    return `<tr id="row-${escapeHtml(t.qid)}" data-qid="${escapeHtml(t.qid)}" data-id="${t.id}">
      <td class="check-col">
        <button class="confirm-btn" title="Check live Wikidata for the P3151 statement">Confirm</button>
        <button class="skip-btn" title="Never offer this taxon again">Skip</button>
      </td>
      <td class="wd-col"><a href="${escapeHtml(t.wdUri)}" target="_blank">${escapeHtml(t.qid)}</a></td>
      <td class="iucn-col">${iucnBadge(t.iucn)}</td>
      <td class="inat-col">${inatCell}</td>
      <td class="confidence-col">${confidence}</td>
      <td class="draft-col">
        <pre class="draft">${escapeHtml(qs)}</pre>
        <span class="hint">Copied!</span>
        <span class="row-msg"></span>
      </td>
    </tr>`;
}

/** Ported from report/generateNamesHTML.js's buildQuickStatements — web/ has no build step and
 *  cannot import lib/'s Node-only code, the same reason links.js reimplements its own tree
 *  rendering instead of importing report/htmlShared.js's. Exported so names.js's QuickStatements
 *  panel can build the same multi-line, sourced block without a second copy of the format. */
export function buildNameQuickStatements(qid, inatId, missing) {
    const wdDate = `+${new Date().toISOString().slice(0, 10)}T00:00:00Z/11`;
    const ref = `\tS248\tQ16958215\tS854\t"https://www.inaturalist.org/taxa/${inatId}"\tS813\t${wdDate}`;
    return missing.map(({ locale, name }) => `${qid}\tP1843\t${locale}:"${name}"${ref}`).join('\n');
}

/** Same shell as imageRowHtml/linkRowHtml, different columns — a name finding proposes several
 *  P1843 statements at once (one per missing locale), so there is no confidence badge (every
 *  candidate already has a confirmed inatId, no ambiguity to flag) and the draft cell carries the
 *  full multi-line, sourced QuickStatements block rather than a one-liner. */
function nameRowHtml(t) {
    const inatId = t.inatTaxonId;
    const inatCell = inatId
        ? `<a href="${escapeHtml(INAT_TAXON(inatId))}" target="_blank">${escapeHtml(inatId)}</a>`
        : '—';
    const missing = t.payload?.missing ?? [];
    const namesHtml = missing.map(({ locale, name }) =>
        `<span class="name-entry"><span class="locale">${escapeHtml(locale)}</span> ${escapeHtml(name)}</span>`
    ).join('');
    const qs = inatId ? buildNameQuickStatements(t.qid, inatId, missing) : '';

    return `<tr id="row-${escapeHtml(t.qid)}" data-qid="${escapeHtml(t.qid)}" data-id="${t.id}">
      <td class="check-col">
        <button class="confirm-btn" title="Check live Wikidata for these names">Confirm</button>
        <button class="skip-btn" title="Never offer this taxon again">Skip</button>
      </td>
      <td class="wd-col"><a href="${escapeHtml(t.wdUri)}" target="_blank">${escapeHtml(t.qid)}</a></td>
      <td class="iucn-col">${iucnBadge(t.iucn)}</td>
      <td class="taxon-col">${escapeHtml(t.taxonName || '—')}</td>
      <td class="inat-col">${inatCell}</td>
      <td class="names-col">${namesHtml}</td>
      <td class="draft-col">
        <pre class="draft">${escapeHtml(qs)}</pre>
        <span class="hint">Copied!</span>
        <span class="row-msg"></span>
      </td>
    </tr>`;
}

const RENDERERS = { image: imageRowHtml, link: linkRowHtml, name: nameRowHtml };

/** Dispatched by t.kind — the table itself (paging, confirm/skip delegation, applyResult) is one
 *  shared shell; only the per-kind markup differs. */
export function rowHtml(t) {
    return (RENDERERS[t.kind] ?? imageRowHtml)(t);
}

// ---- copy helper (browser-side reimplementation of htmlShared.js) ----
function copyViaTextarea(text) {
    const ta = document.createElement('textarea');
    ta.value = text;
    document.body.appendChild(ta);
    ta.select();
    document.execCommand('copy');
    document.body.removeChild(ta);
}

export function copyDraft(el) {
    const text = el.textContent;
    const hint = el.nextElementSibling;
    const show = () => { hint.style.display = 'inline'; setTimeout(() => { hint.style.display = 'none'; }, 1500); };
    if (!navigator.clipboard) { copyViaTextarea(text); show(); return; }
    // The rejection branch is not theoretical: writeText throws NotAllowedError whenever the
    // document is not focused, which is every click that lands while another window has focus.
    // Without the catch there was no copy *and* no hint — the click just did nothing.
    navigator.clipboard.writeText(text).then(show, () => { copyViaTextarea(text); show(); });
}

/**
 * A table of findings: renders rows, delegates their events, and applies confirm/skip results.
 *
 * @param {{
 *   tbody: HTMLElement,
 *   postJson: (path: string, body?: object) => Promise<any>,
 *   hidingDone?: () => boolean,
 *   onStatus?: (msg: string) => void,
 *   onChange?: () => void,
 * }} opts
 */
export function createRowTable({ tbody, postJson, hidingDone = () => false, onStatus = () => {}, onChange = () => {} }) {
    const rowFor = (qid) => tbody.querySelector(`[data-qid="${CSS.escape(qid)}"]`);

    function applyResult(result) {
        const row = rowFor(result.qid);
        if (!row) return;
        const msg = row.querySelector('.row-msg');

        if (result.confirmed) {
            row.classList.add('done');
            if (hidingDone()) row.classList.add('hide-done');
            msg.textContent = 'Confirmed — it will leave the backlog on reload.';
            msg.className = 'row-msg ok';
            return;
        }
        row.classList.remove('done', 'hide-done');
        msg.textContent = REASONS[result.reason] ?? result.reason;
        msg.className = 'row-msg warn';
    }

    async function confirm(ids) {
        if (ids.length === 0) return [];
        try {
            const { results } = await postJson('api/findings/confirm', { ids });
            results.forEach(applyResult);
            onChange();
            return results;
        } catch (e) {
            onStatus(`Could not confirm: ${e.message}`);
            return [];
        }
    }

    async function skip(row) {
        const id = Number(row.dataset.id);
        try {
            await postJson(`api/findings/${id}/skip`, {});
            row.classList.add('done');
            if (hidingDone()) row.classList.add('hide-done');
            row.querySelector('.row-msg').textContent = 'Skipped — it will not be offered again.';
            row.querySelector('.row-msg').className = 'row-msg ok';
            onChange();
        } catch (e) {
            onStatus(`Could not skip: ${e.message}`);
        }
    }

    // Delegated, so rows rendered later need no wiring of their own.
    tbody.addEventListener('click', async (e) => {
        const target = /** @type {HTMLElement} */ (e.target);
        const row = /** @type {HTMLElement|null} */ (target.closest('tr[data-qid]'));
        if (row && target.matches('.confirm-btn')) {
            /** @type {HTMLButtonElement} */ (target).disabled = true;
            row.querySelector('.row-msg').textContent = 'Checking Wikidata…';
            await confirm([Number(row.dataset.id)]);
            /** @type {HTMLButtonElement} */ (target).disabled = false;
            return;
        }
        if (row && target.matches('.skip-btn')) return skip(row);

        const draft = target.closest('.draft');
        if (draft) copyDraft(draft);
    });

    return {
        render(taxa) { tbody.innerHTML = taxa.map(rowHtml).join('\n'); },
        applyResult,
        confirm,
        skip,
        rowFor,
    };
}
