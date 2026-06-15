// @ts-check
import fs from 'fs';
import { escapeHtml, qidFromUri } from './utils.js';

function buildRow(uri, wikitext, inatTaxonIds) {
    const qid = qidFromUri(uri);

    // {{Taxonavigation}} uses positional pipes: Species|name|, Genus|name|, etc.
    // {{Coleoptera}}/{{Lepidoptera}} use named params: |genus=X |species=Y (epithet only).
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
    const commonsUrl = taxonName
        ? `https://commons.wikimedia.org/w/index.php?title=Category:${encodeURIComponent(taxonName).replace(/%20/g, '_')}&action=edit`
        : null;
    const commonsCell = commonsUrl
        ? `<a href="${escapeHtml(commonsUrl)}" target="_blank">${escapeHtml(taxonName)}</a>`
        : '&mdash;';

    const inatTaxonId = inatTaxonIds[uri];
    const inatUrl = inatTaxonId
        ? `https://www.inaturalist.org/observations?taxon_id=${inatTaxonId}&photo_license=cc0%2Ccc-by%2Ccc-by-sa&quality_grade=research`
        : null;
    const inatCell = inatUrl
        ? `<a href="${escapeHtml(inatUrl)}" target="_blank">${inatTaxonId}</a>`
        : '&mdash;';

    return `    <tr id="row-${qid}">
      <td class="check-col"><input type="checkbox" id="cb-${qid}" onchange="setDone('${qid}', this.checked)"></td>
      <td class="wd-col"><a href="${escapeHtml(uri)}" target="_blank">${qid}</a></td>
      <td class="inat-col">${inatCell}</td>
      <td class="commons-col">${commonsCell}</td>
      <td class="draft-col">
        <pre class="draft" onclick="copy(this)">${escapeHtml(wikitext)}</pre>
        <span class="hint">Copied!</span>
      </td>
    </tr>`;
}

/**
 * @param {Record<string, string>} drafts - wdUri → Wikitext draft
 * @param {Record<string, string>} inatTaxonIds - wdUri → iNat taxon ID
 * @param {string} [outputFile]
 * @returns {Promise<void>}
 */
export async function generateDraftsHTML(drafts, inatTaxonIds, outputFile = 'drafts.html') {
    const entries = Object.entries(drafts);
    if (entries.length === 0) {
        console.log('No drafts to render.');
        return;
    }

    const rows = entries.map(([uri, wikitext]) => buildRow(uri, wikitext, inatTaxonIds)).join('\n');

    const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>Wikitext Drafts</title>
  <style>
    body { font-family: sans-serif; padding: 1.5em; color: #222; }
    h1 { font-size: 1.2em; margin-bottom: 0.3em; }
    p  { margin: 0 0 1em; color: #555; font-size: 0.9em; }
    #controls { margin-bottom: 0.75em; }
    #hide-done { font-size: 0.85em; padding: 0.25em 0.6em; cursor: pointer; }
    table { border-collapse: collapse; width: 100%; }
    th { text-align: left; padding: 0.5em 0.75em; background: #f0f0f0;
         border-bottom: 2px solid #ccc; font-size: 0.85em; }
    td { vertical-align: top; padding: 0.4em 0.75em;
         border-bottom: 1px solid #e8e8e8; }
    .check-col { width: 2em; text-align: center; }
    tr.done td { opacity: 0.35; }
    tr.done .draft { background: #f0f0f0; cursor: default; }
    tr.hide-done { display: none; }
    .wd-col { width: 9em; white-space: nowrap; }
    .wd-col a { font-family: monospace; font-size: 0.9em; }
    .inat-col { width: 7em; font-size: 0.85em; font-family: monospace; }
    .commons-col { width: 16em; font-size: 0.85em; }
    .draft-col { position: relative; }
    .draft {
      font-family: monospace; font-size: 0.82em; white-space: pre-wrap;
      background: #f8f8f8; padding: 0.5em 0.75em;
      border: 1px solid #ddd; border-radius: 4px;
      cursor: pointer; margin: 0; line-height: 1.5;
      transition: background 0.15s;
    }
    .draft:hover { background: #eef6ee; border-color: #5a5; }
    .hint {
      display: none; position: absolute; top: 0.4em; right: 0.75em;
      background: #2a2; color: #fff; font-size: 0.75em;
      padding: 0.2em 0.5em; border-radius: 3px; pointer-events: none;
    }
  </style>
</head>
<body>
  <h1>Wikitext Drafts &mdash; ${entries.length} items</h1>
  <div id="controls">
    <button id="hide-done" onclick="toggleHideDone()">Hide done</button>
  </div>
  <p>Click draft text to copy to clipboard. Check the box when done.</p>
  <table>
    <thead>
      <tr>
        <th class="check-col"></th>
        <th>Wikidata item</th>
        <th>iNat taxon</th>
        <th>Commons category</th>
        <th>Draft Wikitext (click to copy)</th>
      </tr>
    </thead>
    <tbody>
${rows}
    </tbody>
  </table>
  <script>
    function copy(el) {
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
    }

    function setDone(qid, done) {
      localStorage.setItem('done-' + qid, done ? '1' : '');
      const row = document.getElementById('row-' + qid);
      row.classList.toggle('done', done);
      if (done && hidingDone) row.classList.add('hide-done');
      if (!done) row.classList.remove('hide-done');
    }

    let hidingDone = localStorage.getItem('hide-done') === '1';

    function toggleHideDone() {
      hidingDone = !hidingDone;
      localStorage.setItem('hide-done', hidingDone ? '1' : '');
      document.getElementById('hide-done').textContent = hidingDone ? 'Show done' : 'Hide done';
      document.querySelectorAll('tr.done').forEach(row => {
        row.classList.toggle('hide-done', hidingDone);
      });
    }

    // Restore state on load
    document.addEventListener('DOMContentLoaded', () => {
      document.querySelectorAll('input[type=checkbox]').forEach(cb => {
        const qid = cb.id.replace('cb-', '');
        if (localStorage.getItem('done-' + qid)) {
          cb.checked = true;
          const row = document.getElementById('row-' + qid);
          row.classList.add('done');
          if (hidingDone) row.classList.add('hide-done');
        }
      });
      if (hidingDone) {
        document.getElementById('hide-done').textContent = 'Show done';
      }
    });
  </script>
</body>
</html>`;

    fs.writeFileSync(outputFile, html, 'utf8');
    console.log(`HTML written to ${outputFile} (${entries.length} drafts)`);
}
