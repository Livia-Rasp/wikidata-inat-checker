// @ts-check
import fs from 'fs';
import { escapeHtml } from '../lib/utils.js';
import { renderReportPage, doneScript, BASE_REPORT_CSS } from './htmlShared.js';
import { outputPath, ensureParentDir } from '../lib/paths.js';

// Official IUCN Red List category colours. The backlog now mixes categories from different runs,
// so the badge is the fastest way to see what a row is; using the Red List's own palette means it
// reads correctly to anyone who works with this data, rather than inventing a scale.
const IUCN_COLORS = {
    EX: '#000000', EW: '#542344', CR: '#d81e05', EN: '#fc7f3f',
    VU: '#f9e814', NT: '#cce226', LC: '#60c659', DD: '#d1d1c6',
};
// Light backgrounds need dark text; the rest are dark enough for white.
const IUCN_DARK_TEXT = new Set(['VU', 'NT', 'LC', 'DD']);

function iucnCell(iucn) {
    if (!iucn || !IUCN_COLORS[iucn]) return '&mdash;';
    const fg = IUCN_DARK_TEXT.has(iucn) ? '#1a1a1a' : '#ffffff';
    return `<span class="iucn" style="background:${IUCN_COLORS[iucn]};color:${fg}">${escapeHtml(iucn)}</span>`;
}

function buildRow({ qid, wdUri, inatTaxonId, taxonName, iucn, wikitext }) {
    const commonsUrl = taxonName
        ? `https://commons.wikimedia.org/w/index.php?title=Category:${encodeURIComponent(taxonName).replace(/%20/g, '_')}&action=edit`
        : null;
    const commonsCell = commonsUrl
        ? `<a href="${escapeHtml(commonsUrl)}" target="_blank">${escapeHtml(taxonName)}</a>`
        : '&mdash;';

    const inatUrl = inatTaxonId
        ? `https://www.inaturalist.org/observations?taxon_id=${inatTaxonId}&photo_license=cc0%2Ccc-by%2Ccc-by-sa&quality_grade=research`
        : null;
    const inatCell = inatUrl
        ? `<a href="${escapeHtml(inatUrl)}" target="_blank">${inatTaxonId}</a>`
        : '&mdash;';

    return `    <tr id="row-${qid}">
      <td class="check-col"><input type="checkbox" id="cb-${qid}" onchange="setDone('${qid}', this.checked)"></td>
      <td class="wd-col"><a href="${escapeHtml(wdUri)}" target="_blank">${qid}</a></td>
      <td class="iucn-col">${iucnCell(iucn)}</td>
      <td class="inat-col">${inatCell}</td>
      <td class="commons-col">${commonsCell}</td>
      <td class="draft-col">
        <pre class="draft" onclick="copy(this)">${escapeHtml(wikitext)}</pre>
        <span class="hint">Copied!</span>
      </td>
    </tr>`;
}

/**
 * Renders the open image backlog. `findings` is the whole accumulated worklist from the findings
 * database, not just the taxa the current run discovered — running the checker again grows this
 * page rather than replacing it.
 * @param {import('../lib/db.js').FindingRow[]} findings
 * @param {string} [outputFile]
 * @returns {Promise<void>}
 */
export async function generateDraftsHTML(findings, outputFile = outputPath('drafts.html')) {
    if (findings.length === 0) {
        console.log('No drafts to render.');
        return;
    }

    const rows = findings.map(buildRow).join('\n');

    const css = `${BASE_REPORT_CSS}
    .inat-col { width: 7em; font-size: 0.85em; font-family: monospace; }
    .commons-col { width: 16em; font-size: 0.85em; }
    .iucn-col { width: 4em; text-align: center; }
    .iucn {
      display: inline-block; min-width: 2.2em; padding: 0.1em 0.4em;
      border-radius: 3px; font-size: 0.75em; font-weight: 700;
      font-family: monospace; letter-spacing: 0.03em;
    }
    .draft { font-size: 0.82em; }`;

    const html = renderReportPage({
        title: 'Wikitext Drafts',
        heading: `Wikitext Drafts &mdash; ${findings.length} items`,
        intro: 'The full open backlog, accumulated across runs. Click draft text to copy to clipboard. Check the box when done.',
        css,
        thead: `      <tr>
        <th class="check-col"></th>
        <th>Wikidata item</th>
        <th class="iucn-col">IUCN</th>
        <th>iNat taxon</th>
        <th>Commons category</th>
        <th>Draft Wikitext (click to copy)</th>
      </tr>`,
        rows,
        script: doneScript(),
    });

    fs.writeFileSync(ensureParentDir(outputFile), html, 'utf8');
    console.log(`HTML written to ${outputFile} (${findings.length} drafts)`);
}
