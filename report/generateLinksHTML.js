// @ts-check
import fs from 'fs';
import { escapeHtml } from '../lib/utils.js';
import { renderTreePair, renderReportPage, doneScript, BASE_REPORT_CSS, TREE_PAIR_CSS } from './htmlShared.js';
import { outputPath, ensureParentDir } from '../lib/paths.js';

/**
 * @typedef {{ wdUri: string, qid: string, taxonName: string, inatId: string }} Match
 * @typedef {Match & { conflictWdUri: string, conflictQid: string, conflictTaxonName: string | null }} Conflict
 */

function buildQS(qid, inatId) {
    return `${qid}\tP3151\t"${inatId}"`;
}

function buildMatchRow({ wdUri, qid, taxonName, inatId }, wdTreeMap, inatTreeMap) {
    const inatUrl = `https://www.inaturalist.org/taxa/${inatId}`;
    const qs = buildQS(qid, inatId);
    return `    <tr id="row-${qid}">
      <td class="check-col"><input type="checkbox" id="cb-${qid}" onchange="setDone('${qid}', this.checked)"></td>
      <td class="wd-col"><a href="${escapeHtml(wdUri)}" target="_blank">${escapeHtml(qid)}</a></td>
      <td class="taxon-col">${escapeHtml(taxonName)}</td>
      <td class="inat-col"><a href="${escapeHtml(inatUrl)}" target="_blank">${escapeHtml(inatId)}</a></td>
      <td class="qs-col">
        <pre class="qs" onclick="copy(this)">${escapeHtml(qs)}</pre>
        <span class="hint">Copied!</span>
      </td>
      <td class="tree-pair-col">${renderTreePair(wdTreeMap.get(qid), inatTreeMap.get(inatId))}</td>
    </tr>`;
}

function buildConflictRow({ taxonName, wdUri, qid, inatId, conflictWdUri, conflictQid }) {
    const inatUrl = `https://www.inaturalist.org/taxa/${inatId}`;
    return `    <tr>
      <td class="inat-col"><a href="${escapeHtml(inatUrl)}" target="_blank">${escapeHtml(inatId)}</a></td>
      <td class="taxon-col">${escapeHtml(taxonName)}</td>
      <td class="wd-col"><a href="${escapeHtml(wdUri)}" target="_blank">${escapeHtml(qid)}</a></td>
      <td class="wd-col"><a href="${escapeHtml(conflictWdUri)}" target="_blank">${escapeHtml(conflictQid)}</a></td>
    </tr>`;
}

/**
 * @param {Match[]} matches
 * @param {Conflict[]} conflicts
 * @param {Map<string, object[]>} [wdTreeMap]
 * @param {Map<string, object[]>} [inatTreeMap]
 * @param {string} [outputFile]
 * @returns {Promise<void>}
 */
export async function generateLinksHTML(matches, conflicts, wdTreeMap = new Map(), inatTreeMap = new Map(), outputFile = outputPath('links.html')) {
    const matchRows = matches.map(m => buildMatchRow(m, wdTreeMap, inatTreeMap)).join('\n');

    const conflictSection = conflicts.length === 0 ? '' : `
  <h2>Conflicts &mdash; ${conflicts.length} items</h2>
  <p>These iNaturalist IDs were found by name-search but are already linked to a different Wikidata item.
     Manual investigation needed before adding.</p>
  <table>
    <thead>
      <tr>
        <th>iNat taxon</th>
        <th>Taxon name (matched)</th>
        <th>WD item matching by name</th>
        <th>WD item currently holding iNat ID</th>
      </tr>
    </thead>
    <tbody>
${conflicts.map(buildConflictRow).join('\n')}
    </tbody>
  </table>`;

    const css = `${BASE_REPORT_CSS}
    .taxon-col { font-style: italic; font-size: 0.9em; }
    .inat-col { width: 7em; font-size: 0.85em; font-family: monospace; }
    #aggregate-container { position: relative; margin-bottom: 1em; }
${TREE_PAIR_CSS}`;

    const html = renderReportPage({
        title: 'Missing iNaturalist Links',
        heading: `Missing iNaturalist Links &mdash; ${matches.length} items`,
        intro: 'Click QuickStatements text to copy. Paste into <a href="https://quickstatements.toolforge.org/" target="_blank">QuickStatements</a> to import.',
        css,
        aggregate: true,
        thead: `      <tr>
        <th class="check-col"></th>
        <th>Wikidata item</th>
        <th>Taxon name</th>
        <th>iNat taxon</th>
        <th>QuickStatements (click to copy)</th>
        <th>Taxonomy (WD&nbsp;&middot;&nbsp;iNat)</th>
      </tr>`,
        rows: matchRows,
        trailing: conflictSection,
        script: doneScript({ segment: 'links', aggregate: true }),
    });

    fs.writeFileSync(ensureParentDir(outputFile), html, 'utf8');
    console.log(`HTML written to ${outputFile} (${matches.length} matches, ${conflicts.length} conflicts)`);
}
