// The search page: which taxa already on the worklist are in this clade, with this Red List status.
//
// Slice 5 put a scope form on the list page, and using it exposed what was wrong with it: it
// *fetched* into the list instead of filtering it, so asking for orchids gave you the whole backlog
// with orchids somewhere inside. Searching and fetching had been conflated into one box that only
// did the expensive half. Here they are separate, and the order matters — you look first, in the
// backlog you already have, and only ask for more if looking was not enough.
//
// **Offer, never act.** Nothing on this page starts a discovery run except a click on a button that
// says it will. A typo must never turn into minutes of Wikimedia and iNaturalist traffic.

import { getJson, postJson } from './api.js';
import { createRowTable, escapeHtml } from './rows.js';
import { createTopup, describe } from './topup.js';
import { createPager, PAGE_SIZE } from './pager.js';
import { mountShell } from './shell.js';

/** Which backlog this page instance searches — set once at boot from ?kind=, never changes while
 *  the page is open. 'image' is the default so a bare search.html (or an old bookmark) keeps
 *  working exactly as it always has. */
const KIND_FROM_QUERY = new URLSearchParams(location.search).get('kind');
const KIND = KIND_FROM_QUERY === 'link' ? 'link' : KIND_FROM_QUERY === 'name' ? 'name' : 'image';
const TOOL = KIND === 'link' ? 'links' : KIND === 'name' ? 'names' : 'images';
/** shell.js's NAV entries use 'images' (plural) for the image kind, but 'link'/'name' (singular)
 *  for the others — this maps KIND to the id mountShell expects. */
const SHELL_ID = KIND === 'image' ? 'images' : KIND;
const BACK_HREF = { image: 'index.html', link: 'links.html', name: 'names.html' };

const THEAD_HTML = {
    image: `<tr>
        <th class="check-col"></th>
        <th>Wikidata item</th>
        <th class="iucn-col">IUCN</th>
        <th>iNat taxon</th>
        <th>Commons category</th>
        <th>Photos</th>
        <th>Draft Wikitext (click to copy)</th>
      </tr>`,
    link: `<tr>
        <th class="check-col"></th>
        <th>Wikidata item</th>
        <th class="iucn-col">IUCN</th>
        <th>iNat taxon</th>
        <th>Confidence</th>
        <th>QuickStatements (click to copy)</th>
      </tr>`,
    name: `<tr>
        <th class="check-col"></th>
        <th>Wikidata item</th>
        <th class="iucn-col">IUCN</th>
        <th>Taxon name</th>
        <th>iNat taxon</th>
        <th>Missing names</th>
        <th>QuickStatements (click to copy)</th>
      </tr>`,
};

mountShell(SHELL_ID);
document.getElementById('thead').innerHTML = THEAD_HTML[KIND];
document.getElementById('back-link').href = BACK_HREF[KIND];

const $ = (id) => document.getElementById(id);

/** Long enough that typing a word is one request, short enough to feel immediate. */
const DEBOUNCE_MS = 300;

/** Below this, the backlog is thin enough that offering to fetch more is the helpful thing. */
const THIN_RESULTS = 25;

const pager = createPager({
    el: $('pager'),
    scrollTo: $('result-count'),
    // Changing page keeps the query and moves within it, so Back steps a page rather than leaving.
    onPage: (offset) => search({ ...current, offset }, { history: 'push' }),
});

const table = createRowTable({
    tbody: $('tbody'),
    postJson,
    onStatus: (msg) => { $('status').textContent = msg; },
});

/** An empty table is a bare header row, which reads as something broken rather than as no results.
 *  The count line above has already said what happened. */
function renderRows(taxa) {
    table.render(taxa);
    document.querySelector('.table-scroll').hidden = taxa.length === 0;
}

/** The last query the server answered, so the offer always scopes to what is on screen. */
let current = { taxon: '', iucn: '', offset: 0 };
let timer = null;
let seq = 0;

// ---- reading and writing the query ----

/** No offset, deliberately: changing what you searched for puts you back on page 1, because page 4
 *  of the orchids is not a meaningful place to land in the beetles. */
function readForm() {
    return {
        taxon: $('q').value.trim(),
        iucn: document.querySelector('input[name="iucn"]:checked')?.value ?? '',
    };
}

function writeForm({ taxon, iucn }) {
    $('q').value = taxon ?? '';
    const chip = document.querySelector(`input[name="iucn"][value="${CSS.escape(iucn ?? '')}"]`);
    if (chip) chip.checked = true;
}

function queryString({ taxon, iucn, offset }) {
    const p = new URLSearchParams();
    // Carried on every URL this page writes, or a reload of a links search silently becomes an
    // images one — KIND is fixed for the life of the page, but the address bar has to say so too.
    if (KIND !== 'image') p.set('kind', KIND);
    if (taxon) p.set('taxon', taxon);
    if (iucn) p.set('iucn', iucn);
    // Named for the API parameter it is, so a URL from the address bar and a URL from the app mean
    // the same thing. Absent on the first page, which is the overwhelmingly common link to share.
    if (offset) p.set('offset', String(offset));
    return p.toString();
}

/**
 * The API request for a query. Built from the same fields as the address-bar URL but separately,
 * because they differ: this one always carries `limit` and `offset`, and appending them to
 * `queryString`'s output would send `offset` twice — which the schema rejects as an array, so the
 * page just stops updating with a 400 nobody looks at.
 */
function apiQuery({ taxon, iucn, offset }) {
    const p = new URLSearchParams({ kind: KIND, limit: String(PAGE_SIZE), offset: String(offset ?? 0) });
    if (taxon) p.set('taxon', taxon);
    if (iucn) p.set('iucn', iucn);
    return p.toString();
}

/** @param {URLSearchParams} p */
function queryFromUrl(p) {
    return {
        taxon: p.get('taxon') ?? '',
        iucn: p.get('iucn') ?? '',
        offset: Math.max(0, Number(p.get('offset')) || 0),
    };
}

// ---- rendering ----

function renderRail(resolved) {
    const rail = $('rail');
    if (!resolved) { rail.hidden = true; rail.innerHTML = ''; return; }

    // Each ancestor widens the search by one rank; the searched taxon itself is the end of the
    // path and not a link, because clicking it would do nothing.
    const steps = (resolved.lineage ?? []).map((a) =>
        `<button type="button" class="rail-step" data-taxon="${escapeHtml(a.inatId)}">
           ${escapeHtml(a.name)}<span class="rail-rank">${escapeHtml(a.rank)}</span>
         </button>`);
    steps.push(`<span class="rail-step rail-here">
        ${escapeHtml(resolved.name ?? resolved.inatId)}<span class="rail-rank">${escapeHtml(resolved.rank ?? '')}</span>
      </span>`);

    rail.innerHTML = steps.join('<span class="rail-sep" aria-hidden="true">›</span>');
    rail.hidden = false;
}

function renderComposition(composition, total) {
    const box = $('composition');
    const entries = composition?.entries ?? [];
    if (entries.length === 0) { box.hidden = true; return; }

    const top = Math.max(...entries.map((e) => e.count));
    // The rank is part of the name here, not decoration: a genus and its type section share a
    // name, so "Below Bulbophyllum → Bulbophyllum 1" is unreadable without it.
    box.querySelector('.composition-label').textContent = composition.under
        ? `Below ${composition.under.name} ${composition.under.rank}`
        : 'In this clade';
    const bars = box.querySelector('.composition-bars');
    bars.innerHTML = entries.map((e) => `
        <button type="button" class="comp" data-taxon="${escapeHtml(e.inatId)}"
                title="${escapeHtml(e.rank)} · ${e.count} of ${total}">
          <span class="comp-name">${escapeHtml(e.name)}</span>
          <span class="rail-rank">${escapeHtml(e.rank)}</span>
          <span class="comp-count">${e.count}</span>
          <span class="comp-bar"></span>
        </button>`).join('');
    // Set through the CSSOM, not a style= attribute: style-src 'self' has no unsafe-inline, so an
    // inline attribute is blocked and every bar would silently render empty.
    bars.querySelectorAll('.comp').forEach((el, i) => {
        el.style.setProperty('--w', `${Math.round((entries[i].count / top) * 100)}%`);
    });
    box.hidden = false;
}

function renderChipCounts(counts) {
    for (const input of document.querySelectorAll('input[name="iucn"]')) {
        const label = input.closest('.chip');
        const n = counts?.[input.value];
        label.querySelector('.chip-count')?.remove();
        if (!input.value) continue;
        // A chip with nothing behind it is a click into an empty result; say so rather than let
        // it be discovered the hard way. Most of the backlog carries no status at all.
        label.classList.toggle('chip-empty', !n);
        if (n) label.insertAdjacentHTML('beforeend', `<span class="chip-count">${n}</span>`);
    }
}

function renderCount(body) {
    const { total, count, offset, degraded } = body;
    const where = current.taxon ? ` in ${body.resolved?.name ?? current.taxon}` : '';
    const status = current.iucn ? ` · ${current.iucn}` : '';
    // The range, not "showing 100": a page has to say *which* hundred, or the pager underneath is
    // the only thing that knows where you are.
    const range = count < total ? ` — showing ${offset + 1}–${offset + count}` : '';
    $('result-count').textContent = total === 0
        ? `Nothing in the backlog${where}${status}.`
        : `${total} open ${total === 1 ? 'finding' : 'findings'}${where}${status}${range}.`;
    $('status').textContent = degraded
        ? 'The iNat taxa index is not built, so this matched names rather than clades. '
          + 'Run a checker from a terminal to search by clade.'
        : '';
}


async function suggestFor(prefix) {
    if (!/^[\p{L}]/u.test(prefix)) return [];
    try {
        const { matches } = await getJson(`api/taxa/suggest?q=${encodeURIComponent(prefix)}&limit=8`);
        return matches;
    } catch {
        return []; // a suggestion that cannot be fetched is not worth an error of its own
    }
}

/** After a failed resolve: what the index does have. Clickable, never applied automatically. */
async function renderSuggestions(typed, extra = '') {
    const box = $('suggestions');
    let matches = await suggestFor(typed);
    // A misspelling is usually at the *end* — "Orchidacae" — and that is exactly where a prefix
    // search gives up. Backing off to a shorter prefix is what turns a dead end into "did you mean
    // Orchidaceae"; without it the offer to fetch is all a typo ever gets.
    if (matches.length === 0 && typed.length > 4) {
        matches = await suggestFor(typed.slice(0, Math.max(4, Math.ceil(typed.length * 0.6))));
    }

    if (matches.length === 0 && !extra) { box.hidden = true; box.innerHTML = ''; return; }
    box.innerHTML = `${extra}${matches.length ? `
        <span class="suggest-label">Did you mean</span>
        ${matches.map((m) => `
          <button type="button" class="suggest" data-taxon="${escapeHtml(m.inatId)}"
                  data-name="${escapeHtml(m.name)}">
            ${escapeHtml(m.name)}<span class="rail-rank">${escapeHtml(m.rank)}</span>
          </button>`).join('')}` : ''}`;
    box.hidden = false;
}

// ---- the offer: scoped discovery, only ever on a click ----

let discoverEnabled = false;

function renderOffer(total, resolved) {
    const box = $('offer');
    if (!discoverEnabled) {
        // Worth saying once rather than leaving a silent gap where a control might belong.
        box.innerHTML = '<span class="muted">Fetching more is off. Start the server with '
            + '<code>DISCOVER_ENABLED=1</code> to turn it on.</span>';
        box.hidden = false;
        return;
    }
    // The resolved name, not what is in the box: arriving here from the rail or the composition
    // strip puts an iNat id there, and "Find more in 738346" tells nobody what they are about to
    // spend minutes fetching.
    const name = resolved?.name || current.taxon;
    const scope = current.taxon
        ? `in ${escapeHtml(name)}`
        : (current.iucn ? `for ${escapeHtml(current.iucn)}` : 'anywhere');
    const thin = total < THIN_RESULTS;
    box.className = `offer${thin ? ' offer-thin' : ''}`;
    box.innerHTML = `
        <button type="button" id="offer-run" class="offer-btn">Find more ${scope}</button>
        <span class="muted">Asks Wikidata and iNaturalist for taxa not yet in the backlog. Minutes.</span>
        <button type="button" id="offer-cancel" hidden>Cancel</button>
        <span id="offer-msg" class="muted"></span>`;
    box.hidden = false;
}

/** The last answered search, so the offer can be re-rendered without asking the server again. */
let lastResult = { total: 0, resolved: null };

const topup = createTopup({
    tool: TOOL,
    onStatus: (s, running) => {
        // The status poll and the first search race on load, and the offer cannot be drawn
        // honestly until this is known — so a change in it redraws the offer rather than waiting
        // for the next search.
        if (s.enabled !== discoverEnabled) {
            discoverEnabled = s.enabled;
            renderOffer(lastResult.total, lastResult.resolved);
        }
        const run = $('offer-run');
        if (!run) return;
        run.disabled = running;
        $('offer-cancel').hidden = !running;
        $('offer-msg').textContent = describe(s);
    },
    // A run changes the backlog this page is a view of, so re-run the search rather than reload:
    // the query the user typed is worth keeping.
    onSettled: () => { setTimeout(() => search(current, { history: 'none' }), 800); },
});

async function startOffer() {
    $('offer-msg').textContent = 'Starting…';
    try {
        await topup.start({ taxon: current.taxon, iucn: current.iucn, limit: 200 });
    } catch (e) {
        $('offer-msg').textContent = e.message;
    }
}

// ---- searching ----

/**
 * @param {{taxon?: string, iucn?: string}} query
 * @param {{history?: 'push'|'replace'|'none'}} opts — walking up the rail or down the composition
 *   strip is *navigation*, so Back has to undo it. Typing is not: debounced keystrokes would
 *   otherwise bury the page you came from under a history entry per word.
 */
async function search(query, { history: mode = 'replace' } = {}) {
    current = { taxon: query.taxon ?? '', iucn: query.iucn ?? '', offset: query.offset ?? 0 };
    $('clear').hidden = !current.taxon && !current.iucn;

    const qs = queryString(current);
    const url = qs ? `?${qs}` : location.pathname;
    if (mode === 'push') history.pushState(null, '', url);
    else if (mode === 'replace') history.replaceState(null, '', url);

    const mine = ++seq;
    try {
        const body = await getJson(`api/search?${apiQuery(current)}`);
        if (mine !== seq) return; // a later keystroke already won

        // A page can outlive its results: skip the last row of the last page, or bookmark page 4
        // of something that has since shrunk, and the server correctly answers with nothing at all.
        const fallback = pager.fallbackOffset(body);
        if (fallback !== null) return search({ ...current, offset: fallback }, { history: 'replace' });

        $('suggestions').hidden = true;
        renderRail(body.resolved);
        renderComposition(body.composition, body.total);
        renderChipCounts(body.iucnCounts);
        renderCount(body);
        renderRows(body.taxa);
        pager.render(body);
        lastResult = { total: body.total, resolved: body.resolved };
        renderOffer(body.total, body.resolved);
    } catch (e) {
        if (mine !== seq) return;
        const code = e.body?.code;
        if (code === 'unknown_taxon' || code === 'ambiguous_taxon') {
            renderNoResolve(code, e.body);
            return;
        }
        $('status').textContent = `Could not search (${e.message}). Is \`npm run web\` still running?`;
    }
}

/** A name the index could not turn into one clade. Both cases end the same way: offer the
 *  alternatives and change nothing until one is chosen. */
function renderNoResolve(code, body) {
    $('rail').hidden = true;
    $('composition').hidden = true;
    renderRows([]);
    // No offer while the scope is unresolved: "find more in Orchidacae" would spend minutes on a
    // typo, which is the one thing this page must never do.
    $('offer').hidden = true;

    if (code === 'ambiguous_taxon') {
        // Genuinely common: Bulbophyllum is a genus *and* a section, and so are hundreds of others.
        $('result-count').textContent = `“${current.taxon}” is more than one taxon.`;
        const chips = (body.matches ?? []).map((m) => `
            <button type="button" class="suggest" data-taxon="${escapeHtml(m.inatId)}"
                    data-name="${escapeHtml(current.taxon)}">
              ${escapeHtml(current.taxon)}<span class="rail-rank">${escapeHtml(m.rank)}</span>
            </button>`).join('');
        renderSuggestions('', `<span class="suggest-label">Which one</span>${chips}`);
        return;
    }
    $('result-count').textContent = `No taxon called “${current.taxon}”.`;
    renderSuggestions(current.taxon);
}

function scheduleSearch() {
    clearTimeout(timer);
    timer = setTimeout(() => search(readForm()), DEBOUNCE_MS);
}

/** Jump straight to a taxon id — from the rail, the composition strip or a suggestion. */
function goToTaxon(inatId, label) {
    $('q').value = label ?? inatId;
    search({ taxon: inatId, iucn: readForm().iucn }, { history: 'push' });
}

// ---- wiring ----

$('q').addEventListener('input', scheduleSearch);
$('q').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { clearTimeout(timer); search(readForm()); }
    if (e.key === 'Escape') { $('q').value = ''; search(readForm()); }
});
$('iucn-chips').addEventListener('change', () => { clearTimeout(timer); search(readForm()); });
$('clear').addEventListener('click', () => {
    writeForm({ taxon: '', iucn: '' });
    search({ taxon: '', iucn: '' });
    $('q').focus();
});

// One delegated listener for every "go to this taxon" control on the page. The pager wires its
// own clicks, so nothing here needs to know about offsets.
document.addEventListener('click', (e) => {
    const jump = e.target.closest('[data-taxon]');
    if (jump) return goToTaxon(jump.dataset.taxon, jump.dataset.name ?? jump.textContent.trim().split('\n')[0]);

    if (e.target.id === 'offer-run') return startOffer();
    if (e.target.id === 'offer-cancel') {
        $('offer-msg').textContent = 'Stopping — the taxa already checked are kept.';
        topup.cancel().catch((err) => { $('offer-msg').textContent = err.message; });
    }
});

window.addEventListener('popstate', () => {
    const q = queryFromUrl(new URLSearchParams(location.search));
    writeForm(q);
    search(q, { history: 'none' });
});

// ---- boot ----
const initial = queryFromUrl(new URLSearchParams(location.search));
writeForm(initial);
// Status first: the offer cannot render honestly until it knows whether discovery exists, and it
// also adopts a run someone started in another tab.
topup.poll().then((s) => { if (s?.state === 'running') topup.watch(); });
// `initial`, not readForm(): the form cannot carry an offset, and a bookmarked page must open on
// the page it names.
search(initial, { history: 'none' });
