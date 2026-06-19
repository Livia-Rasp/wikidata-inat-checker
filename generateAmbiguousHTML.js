// @ts-check
import fs from 'fs';
import { escapeHtml } from './utils.js';
import { renderTreePair, COPY_SCRIPT } from './htmlShared.js';

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
export async function generateAmbiguousHTML(items, wdTreeMap = new Map(), inatTreeMap = new Map(), outputFile = 'links-ambiguous.html') {
    const tableRows = items.map(item => buildRows(item, wdTreeMap, inatTreeMap)).join('\n');

    const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>Ambiguous iNaturalist Links</title>
  <style>
    body { font-family: sans-serif; padding: 1.5em; color: #222; }
    h1 { font-size: 1.2em; margin-bottom: 0.3em; }
    p  { margin: 0 0 1em; color: #555; font-size: 0.9em; }
    #controls { margin-bottom: 0.75em; }
    #hide-done { font-size: 0.85em; padding: 0.25em 0.6em; cursor: pointer; }
    table { border-collapse: collapse; width: 100%; margin-bottom: 1.5em; }
    th { text-align: left; padding: 0.5em 0.75em; background: #f0f0f0;
         border-bottom: 2px solid #ccc; font-size: 0.85em; }
    td { vertical-align: top; padding: 0.4em 0.75em;
         border-bottom: 1px solid #e8e8e8; }
    tr[id] td { border-top: 2px solid #ddd; }
    .check-col { width: 2em; text-align: center; }
    tr.done td { opacity: 0.35; }
    tr.done .qs { background: #f0f0f0; cursor: default; }
    tr.hide-done, tr.hide-done-candidate { display: none; }
    .wd-col { width: 9em; white-space: nowrap; }
    .wd-col a { font-family: monospace; font-size: 0.9em; }
    .taxon-col { font-style: italic; font-size: 0.9em; }
    .inat-col { width: 9em; font-size: 0.85em; font-family: monospace; }
    .rank-badge { font-family: sans-serif; font-style: normal; color: #888;
                  font-size: 0.8em; margin-left: 0.3em; }
    .qs-col { position: relative; }
    .qs {
      font-family: monospace; font-size: 0.78em; white-space: pre-wrap;
      background: #f8f8f8; padding: 0.5em 0.75em;
      border: 1px solid #ddd; border-radius: 4px;
      cursor: pointer; margin: 0; line-height: 1.5;
      transition: background 0.15s;
    }
    .qs:hover { background: #eef6ee; border-color: #5a5; }
    .hint {
      display: none; position: absolute; top: 0.4em; right: 0.75em;
      background: #2a2; color: #fff; font-size: 0.75em;
      padding: 0.2em 0.5em; border-radius: 3px; pointer-events: none;
    }
    .tree-pair-col { vertical-align: top; }
    .tree-pair { border-collapse: collapse; font-size: 0.75em; line-height: 1.5; }
    .tree-pair td { padding: 0.05em 0.35em; vertical-align: top; }
    .tp-rank { color: #999; white-space: nowrap; padding-right: 0.5em; }
    .tp-wd, .tp-inat { min-width: 7em; }
    .tree-match td { color: #2a7; }
    .tree-mismatch td { color: #c33; }
    .absent { color: #ccc; }
    .no-tree { color: #ccc; font-size: 0.8em; }
  </style>
</head>
<body>
  <h1>Ambiguous iNaturalist Links &mdash; ${items.length} items</h1>
  <div id="controls">
    <button id="hide-done" onclick="toggleHideDone()">Hide done</button>
  </div>
  <p>Each row group shows one Wikidata item with multiple matching iNat taxa. The Taxonomy column shows
     WD and iNat ranks aligned side-by-side: <span style="color:#2a7">green</span> = names match,
     <span style="color:#c33">red</span> = names differ. Pick the candidate whose taxonomy aligns with WD,
     then click its QuickStatements cell to copy. Check the box to mark a group resolved.</p>
  <table>
    <thead>
      <tr>
        <th class="check-col"></th>
        <th>Wikidata item</th>
        <th>Taxon name</th>
        <th>iNat candidate</th>
        <th>Taxonomy (WD&nbsp;&middot;&nbsp;iNat)</th>
        <th>QuickStatements (click to copy)</th>
      </tr>
    </thead>
    <tbody>
${tableRows}
    </tbody>
  </table>
  <script>
${COPY_SCRIPT}

    function setDone(qid, done) {
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
    });
  </script>
</body>
</html>`;

    fs.writeFileSync(outputFile, html, 'utf8');
    console.log(`Ambiguous HTML written to ${outputFile} (${items.length} items).`);
}
