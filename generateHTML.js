import fs from 'fs';
import { JsonDB, Config } from 'node-json-db';

const db = new JsonDB(new Config("inattWDPhotoCache", false, true, ';'));

function escapeHtml(str) {
    return str
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

export async function generateDraftsHTML(outputFile = 'drafts.html') {
    await db.reload();

    let drafts;
    try {
        drafts = await db.getData(';drafts');
    } catch {
        console.log('No drafts found, skipping HTML generation.');
        return;
    }

    const entries = Object.entries(drafts);
    if (entries.length === 0) {
        console.log('No drafts to render.');
        return;
    }

    const rows = entries.map(([uri, wikitext]) => {
        const qid = uri.split('/').pop();
        return `    <tr>
      <td class="wd-col"><a href="${escapeHtml(uri)}" target="_blank">${qid}</a></td>
      <td class="draft-col">
        <pre class="draft" onclick="copy(this)">${escapeHtml(wikitext)}</pre>
        <span class="hint">Copied!</span>
      </td>
    </tr>`;
    }).join('\n');

    const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>Wikitext Drafts</title>
  <style>
    body { font-family: sans-serif; padding: 1.5em; color: #222; }
    h1 { font-size: 1.2em; margin-bottom: 0.3em; }
    p  { margin: 0 0 1em; color: #555; font-size: 0.9em; }
    table { border-collapse: collapse; width: 100%; }
    th { text-align: left; padding: 0.5em 0.75em; background: #f0f0f0;
         border-bottom: 2px solid #ccc; font-size: 0.85em; }
    td { vertical-align: top; padding: 0.4em 0.75em;
         border-bottom: 1px solid #e8e8e8; }
    .wd-col { width: 9em; white-space: nowrap; }
    .wd-col a { font-family: monospace; font-size: 0.9em; }
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
  <p>Click draft text to copy to clipboard.</p>
  <table>
    <thead>
      <tr>
        <th>Wikidata item</th>
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
  </script>
</body>
</html>`;

    fs.writeFileSync(outputFile, html, 'utf8');
    console.log(`HTML written to ${outputFile} (${entries.length} drafts)`);
}
