// @ts-check
// Shared helpers for the HTML report generators.
import { escapeHtml, WD_RANK_LABELS } from './utils.js';

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

// Client-side clipboard helper embedded in every report: copies a <pre>'s text and
// briefly flashes its sibling "Copied!" hint. Falls back to execCommand on old browsers.
export const COPY_SCRIPT = `    function copy(el) {
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
