// @ts-check
import fs from 'fs';
import { escapeHtml, qidFromUri } from '../lib/utils.js';
import { extractTaxonName, renderReportPage, doneScript, BASE_REPORT_CSS } from './htmlShared.js';
import { outputPath, ensureParentDir } from '../lib/paths.js';

function buildRow(uri, wikitext, inatTaxonIds) {
    const qid = qidFromUri(uri);

    const taxonName = extractTaxonName(wikitext);
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
export async function generateDraftsHTML(drafts, inatTaxonIds, outputFile = outputPath('drafts.html')) {
    const entries = Object.entries(drafts);
    if (entries.length === 0) {
        console.log('No drafts to render.');
        return;
    }

    const rows = entries.map(([uri, wikitext]) => buildRow(uri, wikitext, inatTaxonIds)).join('\n');

    const css = `${BASE_REPORT_CSS}
    .inat-col { width: 7em; font-size: 0.85em; font-family: monospace; }
    .commons-col { width: 16em; font-size: 0.85em; }
    .draft { font-size: 0.82em; }`;

    const html = renderReportPage({
        title: 'Wikitext Drafts',
        heading: `Wikitext Drafts &mdash; ${entries.length} items`,
        intro: 'Click draft text to copy to clipboard. Check the box when done.',
        css,
        thead: `      <tr>
        <th class="check-col"></th>
        <th>Wikidata item</th>
        <th>iNat taxon</th>
        <th>Commons category</th>
        <th>Draft Wikitext (click to copy)</th>
      </tr>`,
        rows,
        script: doneScript(),
    });

    fs.writeFileSync(ensureParentDir(outputFile), html, 'utf8');
    console.log(`HTML written to ${outputFile} (${entries.length} drafts)`);
}
