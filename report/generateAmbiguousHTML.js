// @ts-check
import fs from 'fs';
import { escapeHtml } from '../lib/utils.js';
import { renderTreePair, renderReportPage, BASE_REPORT_CSS, TREE_PAIR_CSS } from './htmlShared.js';
import { outputPath, ensureParentDir } from '../lib/paths.js';

// Custom done/hide-done script: a resolved group hides its rowspan header row AND its
// sibling candidate rows (which carry data-qid, not an id), so it can't use the standard
// doneScript(). Keyed under the `ambiguous` localStorage namespace.
const AMBIGUOUS_SCRIPT = `    function setDone(qid, done) {
      localStorage.setItem('done-ambiguous-' + qid, done ? '1' : '');
      const row = document.getElementById('row-' + qid);
      row.classList.toggle('done', done);
      const candidates = document.querySelectorAll(\`tr.candidate-row[data-qid="\${qid}"]\`);
      candidates.forEach(r => r.classList.toggle('done', done));
      if (hidingDone) {
        row.classList.toggle('hide-done', done);
        candidates.forEach(r => r.classList.toggle('hide-done-candidate', done));
      }
    }

    let hidingDone = localStorage.getItem('hide-done-ambiguous') === '1';

    function toggleHideDone() {
      hidingDone = !hidingDone;
      localStorage.setItem('hide-done-ambiguous', hidingDone ? '1' : '');
      document.getElementById('hide-done').textContent = hidingDone ? 'Show done' : 'Hide done';
      document.querySelectorAll('tr.done[id]').forEach(row => {
        row.classList.toggle('hide-done', hidingDone);
      });
      document.querySelectorAll('tr.done.candidate-row').forEach(row => {
        row.classList.toggle('hide-done-candidate', hidingDone);
      });
    }

    document.addEventListener('DOMContentLoaded', () => {
      document.querySelectorAll('input[type=checkbox]').forEach(cb => {
        const qid = cb.id.replace('cb-', '');
        if (localStorage.getItem('done-ambiguous-' + qid)) {
          cb.checked = true;
          const row = document.getElementById('row-' + qid);
          row.classList.add('done');
          const candidates = document.querySelectorAll(\`tr.candidate-row[data-qid="\${qid}"]\`);
          candidates.forEach(r => r.classList.add('done'));
          if (hidingDone) {
            row.classList.add('hide-done');
            candidates.forEach(r => r.classList.add('hide-done-candidate'));
          }
        }
      });
      if (hidingDone) document.getElementById('hide-done').textContent = 'Show done';
    });`;

function buildRows(item, wdTreeMap, inatTreeMap) {
    const { wdUri, qid, taxonName, candidates } = item;
    const n = candidates.length;

    return candidates.map(({ inatId, rank }, i) => {
        const inatUrl   = `https://www.inaturalist.org/taxa/${inatId}`;
        const qs        = `${qid}\tP3151\t"${inatId}"`;
        const treePair  = renderTreePair(wdTreeMap.get(qid), inatTreeMap.get(inatId));
        const rankLabel = rank ? ` <span class="rank-badge">${escapeHtml(rank)}</span>` : '';

        if (i === 0) {
            return `    <tr id="row-${qid}">
      <td class="check-col" rowspan="${n}"><input type="checkbox" id="cb-${qid}" onchange="setDone('${qid}', this.checked)"></td>
      <td class="wd-col" rowspan="${n}"><a href="${escapeHtml(wdUri)}" target="_blank">${escapeHtml(qid)}</a></td>
      <td class="taxon-col" rowspan="${n}">${escapeHtml(taxonName)}</td>
      <td class="inat-col"><a href="${escapeHtml(inatUrl)}" target="_blank">${escapeHtml(inatId)}</a>${rankLabel}</td>
      <td class="tree-pair-col">${treePair}</td>
      <td class="qs-col">
        <pre class="qs" onclick="copy(this)">${escapeHtml(qs)}</pre>
        <span class="hint">Copied!</span>
      </td>
    </tr>`;
        }
        return `    <tr class="candidate-row" data-qid="${qid}">
      <td class="inat-col"><a href="${escapeHtml(inatUrl)}" target="_blank">${escapeHtml(inatId)}</a>${rankLabel}</td>
      <td class="tree-pair-col">${treePair}</td>
      <td class="qs-col">
        <pre class="qs" onclick="copy(this)">${escapeHtml(qs)}</pre>
        <span class="hint">Copied!</span>
      </td>
    </tr>`;
    }).join('\n');
}

/**
 * @param {object[]} items  [{wdUri, qid, taxonName, candidates: [{inatId, rank}]}]
 * @param {Map<string, object[]>} [wdTreeMap]
 * @param {Map<string, object[]>} [inatTreeMap]
 * @param {string} [outputFile]
 */
export async function generateAmbiguousHTML(items, wdTreeMap = new Map(), inatTreeMap = new Map(), outputFile = outputPath('links-ambiguous.html')) {
    const tableRows = items.map(item => buildRows(item, wdTreeMap, inatTreeMap)).join('\n');

    const css = `${BASE_REPORT_CSS}
    tr[id] td { border-top: 2px solid #ddd; }
    tr.hide-done-candidate { display: none; }
    .taxon-col { font-style: italic; font-size: 0.9em; }
    .inat-col { width: 9em; font-size: 0.85em; font-family: monospace; }
    .rank-badge { font-family: sans-serif; font-style: normal; color: #888;
                  font-size: 0.8em; margin-left: 0.3em; }
${TREE_PAIR_CSS}`;

    const html = renderReportPage({
        title: 'Ambiguous iNaturalist Links',
        heading: `Ambiguous iNaturalist Links &mdash; ${items.length} items`,
        intro: `Each row group shows one Wikidata item with multiple matching iNat taxa. The Taxonomy column shows
     WD and iNat ranks aligned side-by-side: <span style="color:#2a7">green</span> = names match,
     <span style="color:#c33">red</span> = names differ. Pick the candidate whose taxonomy aligns with WD,
     then click its QuickStatements cell to copy. Check the box to mark a group resolved.`,
        css,
        thead: `      <tr>
        <th class="check-col"></th>
        <th>Wikidata item</th>
        <th>Taxon name</th>
        <th>iNat candidate</th>
        <th>Taxonomy (WD&nbsp;&middot;&nbsp;iNat)</th>
        <th>QuickStatements (click to copy)</th>
      </tr>`,
        rows: tableRows,
        script: AMBIGUOUS_SCRIPT,
    });

    fs.writeFileSync(ensureParentDir(outputFile), html, 'utf8');
    console.log(`Ambiguous HTML written to ${outputFile} (${items.length} items).`);
}
