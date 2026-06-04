import fs from 'fs';

const WD_DATE = `+${new Date().toISOString().slice(0, 10)}T00:00:00Z/11`;

function escapeHtml(str) {
    return str
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

function buildQuickStatements(qid, inatId, missing) {
    const ref = `\tS248\tQ16958215\tS854\t"https://www.inaturalist.org/taxa/${inatId}"\tS813\t${WD_DATE}`;
    return missing
        .map(({ locale, name }) => `${qid}\tP1843\t${locale}:"${name}"${ref}`)
        .join('\n');
}

function buildRow({ wdUri, qid, inatId, taxonName, missing }) {
    const inatUrl = `https://www.inaturalist.org/taxa/${inatId}`;

    const namesHtml = missing
        .map(({ locale, name }) => `<span class="name-entry"><span class="locale">${escapeHtml(locale)}</span> ${escapeHtml(name)}</span>`)
        .join('\n');

    const qs = buildQuickStatements(qid, inatId, missing);

    return `    <tr id="row-${qid}">
      <td class="check-col"><input type="checkbox" id="cb-${qid}" onchange="setDone('${qid}', this.checked)"></td>
      <td class="wd-col"><a href="${escapeHtml(wdUri)}" target="_blank">${qid}</a></td>
      <td class="taxon-col">${escapeHtml(taxonName || '—')}</td>
      <td class="inat-col"><a href="${escapeHtml(inatUrl)}" target="_blank">${inatId}</a></td>
      <td class="names-col">${namesHtml}</td>
      <td class="qs-col">
        <pre class="qs" onclick="copy(this)">${escapeHtml(qs)}</pre>
        <span class="hint">Copied!</span>
      </td>
    </tr>`;
}

export async function generateNamesHTML(items, outputFile = 'names.html') {
    if (items.length === 0) {
        console.log('No missing names found.');
        return;
    }

    const rows = items.map(buildRow).join('\n');

    const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>Missing Vernacular Names</title>
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
    tr.done .qs { background: #f0f0f0; cursor: default; }
    tr.hide-done { display: none; }
    .wd-col { width: 9em; white-space: nowrap; }
    .wd-col a { font-family: monospace; font-size: 0.9em; }
    .taxon-col { width: 14em; font-style: italic; font-size: 0.9em; }
    .inat-col { width: 7em; font-size: 0.85em; font-family: monospace; }
    .names-col { width: 18em; font-size: 0.85em; }
    .name-entry { display: block; line-height: 1.6; }
    .locale { display: inline-block; width: 4.5em; font-family: monospace;
              color: #666; font-size: 0.9em; }
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
  <h1>Missing Vernacular Names &mdash; ${items.length} items</h1>
  <div id="controls">
    <button id="hide-done" onclick="toggleHideDone()">Hide done</button>
  </div>
  <p>Click QuickStatements text to copy. Paste into <a href="https://quickstatements.toolforge.org/" target="_blank">QuickStatements</a> to import.</p>
  <table>
    <thead>
      <tr>
        <th class="check-col"></th>
        <th>Wikidata item</th>
        <th>Taxon name</th>
        <th>iNat taxon</th>
        <th>Missing names</th>
        <th>QuickStatements (click to copy)</th>
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
      localStorage.setItem('done-names-' + qid, done ? '1' : '');
      const row = document.getElementById('row-' + qid);
      row.classList.toggle('done', done);
      if (done && hidingDone) row.classList.add('hide-done');
      if (!done) row.classList.remove('hide-done');
    }

    let hidingDone = localStorage.getItem('hide-done-names') === '1';

    function toggleHideDone() {
      hidingDone = !hidingDone;
      localStorage.setItem('hide-done-names', hidingDone ? '1' : '');
      document.getElementById('hide-done').textContent = hidingDone ? 'Show done' : 'Hide done';
      document.querySelectorAll('tr.done').forEach(row => {
        row.classList.toggle('hide-done', hidingDone);
      });
    }

    document.addEventListener('DOMContentLoaded', () => {
      document.querySelectorAll('input[type=checkbox]').forEach(cb => {
        const qid = cb.id.replace('cb-', '');
        if (localStorage.getItem('done-names-' + qid)) {
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
    console.log(`HTML written to ${outputFile} (${items.length} items)`);
}
