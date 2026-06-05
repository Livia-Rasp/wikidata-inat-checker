import fs from 'fs';

function escapeHtml(str) {
    return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

function buildQS(qid, inatId) {
    return `${qid}\tP3151\t"${inatId}"`;
}

function buildMatchRow({ wdUri, qid, taxonName, inatId }) {
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

export async function generateLinksHTML(matches, conflicts, outputFile = 'links.html') {
    const matchRows = matches.map(buildMatchRow).join('\n');

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

    const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>Missing iNaturalist Links</title>
  <style>
    body { font-family: sans-serif; padding: 1.5em; color: #222; }
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
    tr.done .qs { background: #f0f0f0; cursor: default; }
    tr.hide-done { display: none; }
    .wd-col { width: 9em; white-space: nowrap; }
    .wd-col a { font-family: monospace; font-size: 0.9em; }
    .taxon-col { font-style: italic; font-size: 0.9em; }
    .inat-col { width: 7em; font-size: 0.85em; font-family: monospace; }
    #aggregate-container { position: relative; margin-bottom: 1em; }
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
  </style>
</head>
<body>
  <h1>Missing iNaturalist Links &mdash; ${matches.length} items</h1>
  <div id="controls">
    <button id="hide-done" onclick="toggleHideDone()">Hide done</button>
  </div>
  <div id="aggregate-container" style="display:none">
    <p style="margin:0 0 0.3em">Selected (<span id="aggregate-count">0</span> items) &mdash; click to copy all:</p>
    <pre id="aggregate-qs" class="qs" onclick="copyAggregate()"></pre>
    <span id="aggregate-hint" class="hint">Copied!</span>
  </div>
  <p>Click QuickStatements text to copy. Paste into <a href="https://quickstatements.toolforge.org/" target="_blank">QuickStatements</a> to import.</p>
  <table>
    <thead>
      <tr>
        <th class="check-col"></th>
        <th>Wikidata item</th>
        <th>Taxon name</th>
        <th>iNat taxon</th>
        <th>QuickStatements (click to copy)</th>
      </tr>
    </thead>
    <tbody>
${matchRows}
    </tbody>
  </table>
${conflictSection}
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

    function setDone(qid, done) {
      localStorage.setItem('done-links-' + qid, done ? '1' : '');
      const row = document.getElementById('row-' + qid);
      row.classList.toggle('done', done);
      if (done && hidingDone) row.classList.add('hide-done');
      if (!done) row.classList.remove('hide-done');
      updateAggregate();
    }

    let hidingDone = localStorage.getItem('hide-done-links') === '1';

    function toggleHideDone() {
      hidingDone = !hidingDone;
      localStorage.setItem('hide-done-links', hidingDone ? '1' : '');
      document.getElementById('hide-done').textContent = hidingDone ? 'Show done' : 'Hide done';
      document.querySelectorAll('tr.done').forEach(row => {
        row.classList.toggle('hide-done', hidingDone);
      });
    }

    document.addEventListener('DOMContentLoaded', () => {
      document.querySelectorAll('input[type=checkbox]').forEach(cb => {
        const qid = cb.id.replace('cb-', '');
        if (localStorage.getItem('done-links-' + qid)) {
          cb.checked = true;
          const row = document.getElementById('row-' + qid);
          row.classList.add('done');
          if (hidingDone) row.classList.add('hide-done');
        }
      });
      if (hidingDone) {
        document.getElementById('hide-done').textContent = 'Show done';
      }
      updateAggregate();
    });
  </script>
</body>
</html>`;

    fs.writeFileSync(outputFile, html, 'utf8');
    console.log(`HTML written to ${outputFile} (${matches.length} matches, ${conflicts.length} conflicts)`);
}
