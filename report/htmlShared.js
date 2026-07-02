// @ts-check
// Shared helpers for the HTML report generators.
import { escapeHtml, WD_RANK_LABELS } from '../lib/utils.js';

// Taxonomic ranks in descending order, used to sort the side-by-side tree rows.
const RANK_ORDER = [
    'kingdom','subkingdom','phylum','subphylum',
    'superclass','class','subclass',
    'superorder','order','suborder','infraorder',
    'superfamily','family','subfamily',
    'supertribe','tribe','subtribe',
    'genus','subgenus','section','subsection',
    'species','subspecies','variety',
];

/**
 * Render a Wikidata vs iNaturalist ancestor chain as an aligned two-column table:
 * rows are ranks present in either chain, sorted kingdom→species; cells turn green
 * when the names agree and red when they differ. Used by the links and ambiguous reports.
 * @param {{name: string, rankQid: string|null}[]} [wdChain]   kingdom-first WD chain
 * @param {{name: string, rank: string}[]} [inatChain]         kingdom-first iNat chain
 * @returns {string} HTML
 */
export function renderTreePair(wdChain, inatChain) {
    const wdLabeled = (wdChain ?? [])
        .filter(e => e.rankQid && WD_RANK_LABELS[e.rankQid])
        .map(e => ({ rank: WD_RANK_LABELS[e.rankQid], name: e.name }));
    const inatLabeled = (inatChain ?? [])
        .filter(e => e.rank)
        .map(e => ({ rank: e.rank.toLowerCase(), name: e.name }));

    const wdByRank   = new Map(wdLabeled.map(e  => [e.rank.toLowerCase(), e.name]));
    const inatByRank = new Map(inatLabeled.map(e => [e.rank, e.name]));

    const allRanks = [...new Set([
        ...wdLabeled.map(e => e.rank.toLowerCase()),
        ...inatLabeled.map(e => e.rank),
    ])];
    allRanks.sort((a, b) => {
        const ai = RANK_ORDER.indexOf(a), bi = RANK_ORDER.indexOf(b);
        if (ai === -1 && bi === -1) return 0;
        if (ai === -1) return 1;
        if (bi === -1) return -1;
        return ai - bi;
    });

    if (allRanks.length === 0) return '<span class="no-tree">—</span>';

    return '<table class="tree-pair">' + allRanks.map(rank => {
        const wdName   = wdByRank.get(rank)   ?? '';
        const inatName = inatByRank.get(rank) ?? '';
        let cls = '';
        if (wdName && inatName)
            cls = wdName.toLowerCase() === inatName.toLowerCase() ? ' class="tree-match"' : ' class="tree-mismatch"';
        const label = rank[0].toUpperCase() + rank.slice(1);
        return `<tr${cls}>`
            + `<td class="tp-rank">${escapeHtml(label)}</td>`
            + `<td class="tp-wd">${wdName   ? escapeHtml(wdName)   : '<span class="absent">—</span>'}</td>`
            + `<td class="tp-inat">${inatName ? escapeHtml(inatName) : '<span class="absent">—</span>'}</td>`
            + `</tr>`;
    }).join('') + '</table>';
}

/**
 * Derives the taxon name from a Commons category Wikitext draft, matching the convention
 * used by generateWikitext.js. {{Taxonavigation}} uses positional pipes
 * (Species|name|, Genus|name|, …); {{Coleoptera}}/{{Lepidoptera}} use named params
 * (|genus=X |species=Y with the epithet only). Returns null if no name can be found.
 * @param {string} wikitext
 * @returns {string|null}
 */
export function extractTaxonName(wikitext) {
    const taxonMatches = [...wikitext.matchAll(/(?:Species|Genus|Familia|Ordo|Classis|Subclassis)\|([^|}\n]+)\|/g)];
    let taxonName = taxonMatches.length > 0 ? taxonMatches[taxonMatches.length - 1][1].trim() : null;
    if (!taxonName) {
        const genusMatch   = wikitext.match(/\|genus=([^\n|]+)/);
        const speciesMatch = wikitext.match(/\|species=([^\n|]+)/);
        if (genusMatch) {
            taxonName = speciesMatch
                ? `${genusMatch[1].trim()} ${speciesMatch[1].trim()}`
                : genusMatch[1].trim();
        } else {
            const familiaMatch = wikitext.match(/\|familia=([^\n|]+)/);
            if (familiaMatch) taxonName = familiaMatch[1].trim();
        }
    }
    return taxonName;
}

// Client-side clipboard helper embedded in every report: copies a <pre>'s text and
// briefly flashes its sibling "Copied!" hint. Falls back to execCommand on old browsers.
// Injected by renderReportPage() into every page, so it stays module-private.
const COPY_SCRIPT = `    function copy(el) {
      const text = el.textContent;
      const hint = el.nextElementSibling;
      const show = () => {
        hint.style.display = 'inline';
        setTimeout(() => { hint.style.display = 'none'; }, 1500);
      };
      if (navigator.clipboard) {
        navigator.clipboard.writeText(text).then(show);
      } else {
        const ta = document.createElement('textarea');
        ta.value = text;
        document.body.appendChild(ta);
        ta.select();
        document.execCommand('copy');
        document.body.removeChild(ta);
        show();
      }
    }`;

// ---- shared report-page styling & scaffold --------------------------------------------
// The four review reports (drafts, links, names, ambiguous) share a layout: a heading, a
// "Hide done" control, a copyable <pre> per row, and a done/hidden row state persisted in
// localStorage. These constants + renderReportPage()/doneScript() hold that common shell so
// each generator only supplies its own columns and per-page CSS. (area.html is a different
// shape — sortable, no copy/done — and does not use these.)

// Base CSS shared by all four reports. Pages append their own column widths etc. as extra
// CSS. Copyable blocks use either `.qs` (QuickStatements) or `.draft` (Wikitext); both are
// styled together here so a page just picks the class its rows use.
export const BASE_REPORT_CSS = `    body { font-family: sans-serif; padding: 1.5em; color: #222; }
    h1, h2 { font-size: 1.2em; margin-bottom: 0.3em; }
    h2 { margin-top: 2em; }
    p  { margin: 0 0 1em; color: #555; font-size: 0.9em; }
    #controls { margin-bottom: 0.75em; }
    #hide-done { font-size: 0.85em; padding: 0.25em 0.6em; cursor: pointer; }
    table { border-collapse: collapse; width: 100%; margin-bottom: 1.5em; }
    th { text-align: left; padding: 0.5em 0.75em; background: #f0f0f0;
         border-bottom: 2px solid #ccc; font-size: 0.85em; }
    td { vertical-align: top; padding: 0.4em 0.75em;
         border-bottom: 1px solid #e8e8e8; }
    .check-col { width: 2em; text-align: center; }
    tr.done td { opacity: 0.35; }
    tr.done .qs, tr.done .draft { background: #f0f0f0; cursor: default; }
    tr.hide-done { display: none; }
    .wd-col { width: 9em; white-space: nowrap; }
    .wd-col a { font-family: monospace; font-size: 0.9em; }
    .qs-col, .draft-col { position: relative; }
    .qs, .draft {
      font-family: monospace; font-size: 0.78em; white-space: pre-wrap;
      background: #f8f8f8; padding: 0.5em 0.75em;
      border: 1px solid #ddd; border-radius: 4px;
      cursor: pointer; margin: 0; line-height: 1.5;
      transition: background 0.15s;
    }
    .qs:hover, .draft:hover { background: #eef6ee; border-color: #5a5; }
    .hint {
      display: none; position: absolute; top: 0.4em; right: 0.75em;
      background: #2a2; color: #fff; font-size: 0.75em;
      padding: 0.2em 0.5em; border-radius: 3px; pointer-events: none;
    }`;

// The side-by-side WD/iNat taxonomy-tree columns (links + ambiguous reports).
export const TREE_PAIR_CSS = `    .tree-pair-col { vertical-align: top; }
    .tree-pair { border-collapse: collapse; font-size: 0.75em; line-height: 1.5; }
    .tree-pair td { padding: 0.05em 0.35em; vertical-align: top; }
    .tp-rank { color: #999; white-space: nowrap; padding-right: 0.5em; }
    .tp-wd, .tp-inat { min-width: 7em; }
    .tree-match td { color: #2a7; }
    .tree-mismatch td { color: #c33; }
    .absent { color: #ccc; }
    .no-tree { color: #ccc; font-size: 0.8em; }`;

/**
 * Client script for the standard row done/hide-done behaviour, with an optional
 * "copy all selected" aggregate panel (links + names). `segment` namespaces the
 * localStorage keys so each report remembers its own state independently: '' →
 * `done-<qid>`/`hide-done`, 'links' → `done-links-<qid>`/`hide-done-links`, etc.
 * @param {{ segment?: string, aggregate?: boolean }} opts
 * @returns {string}
 */
export function doneScript({ segment = '', aggregate = false } = {}) {
    const doneKey = `done-${segment ? segment + '-' : ''}`;
    const hideKey = `hide-done${segment ? '-' + segment : ''}`;
    const aggCall = aggregate ? '\n      updateAggregate();' : '';
    const aggFns = aggregate ? `
    function updateAggregate() {
      const rows = [...document.querySelectorAll('tr.done[id^="row-"]')];
      const statements = rows
        .map(row => row.querySelector('.qs')?.textContent ?? '')
        .filter(Boolean)
        .join('\\n');
      const container = document.getElementById('aggregate-container');
      document.getElementById('aggregate-count').textContent = rows.length;
      document.getElementById('aggregate-qs').textContent = statements;
      container.style.display = rows.length > 0 ? '' : 'none';
    }

    function copyAggregate() {
      const text = document.getElementById('aggregate-qs').textContent;
      const hint = document.getElementById('aggregate-hint');
      const show = () => {
        hint.style.display = 'inline';
        setTimeout(() => { hint.style.display = 'none'; }, 1500);
      };
      if (navigator.clipboard) {
        navigator.clipboard.writeText(text).then(show);
      } else {
        const ta = document.createElement('textarea');
        ta.value = text;
        document.body.appendChild(ta);
        ta.select();
        document.execCommand('copy');
        document.body.removeChild(ta);
        show();
      }
    }
` : '';
    return `${aggFns}
    function setDone(qid, done) {
      localStorage.setItem('${doneKey}' + qid, done ? '1' : '');
      const row = document.getElementById('row-' + qid);
      row.classList.toggle('done', done);
      if (done && hidingDone) row.classList.add('hide-done');
      if (!done) row.classList.remove('hide-done');${aggCall}
    }

    let hidingDone = localStorage.getItem('${hideKey}') === '1';

    function toggleHideDone() {
      hidingDone = !hidingDone;
      localStorage.setItem('${hideKey}', hidingDone ? '1' : '');
      document.getElementById('hide-done').textContent = hidingDone ? 'Show done' : 'Hide done';
      document.querySelectorAll('tr.done').forEach(row => {
        row.classList.toggle('hide-done', hidingDone);
      });
    }

    document.addEventListener('DOMContentLoaded', () => {
      document.querySelectorAll('input[type=checkbox]').forEach(cb => {
        const qid = cb.id.replace('cb-', '');
        if (localStorage.getItem('${doneKey}' + qid)) {
          cb.checked = true;
          const row = document.getElementById('row-' + qid);
          row.classList.add('done');
          if (hidingDone) row.classList.add('hide-done');
        }
      });
      if (hidingDone) {
        document.getElementById('hide-done').textContent = 'Show done';
      }${aggCall}
    });`;
}

/**
 * Assemble a full review-report HTML document from its parts. Emits the shared skeleton
 * (doctype/head/style, heading, "Hide done" control, optional aggregate panel, table,
 * and the copy() helper + page script). `thead` is the `<tr>…</tr>` header row and `rows`
 * the joined `<tr>` body rows; `trailing` is any extra markup after the table (e.g. a
 * conflicts section); `css` is BASE_REPORT_CSS plus the page's own rules.
 * @param {{ title: string, heading: string, intro: string, css: string, thead: string,
 *           rows: string, script: string, aggregate?: boolean, trailing?: string, lang?: string }} opts
 * @returns {string}
 */
export function renderReportPage({ title, heading, intro, css, thead, rows, script, aggregate = false, trailing = '', lang = 'en' }) {
    const aggregatePanel = aggregate ? `
  <div id="aggregate-container" style="display:none">
    <p style="margin:0 0 0.3em">Selected (<span id="aggregate-count">0</span> items) &mdash; click to copy all:</p>
    <pre id="aggregate-qs" class="qs" onclick="copyAggregate()"></pre>
    <span id="aggregate-hint" class="hint">Copied!</span>
  </div>` : '';
    return `<!DOCTYPE html>
<html lang="${lang}">
<head>
  <meta charset="UTF-8">
  <title>${title}</title>
  <style>
${css}
  </style>
</head>
<body>
  <h1>${heading}</h1>
  <div id="controls">
    <button id="hide-done" onclick="toggleHideDone()">Hide done</button>
  </div>${aggregatePanel}
  <p>${intro}</p>
  <table>
    <thead>
${thead}
    </thead>
    <tbody>
${rows}
    </tbody>
  </table>${trailing}
  <script>
${COPY_SCRIPT}
${script}
  </script>
</body>
</html>`;
}
