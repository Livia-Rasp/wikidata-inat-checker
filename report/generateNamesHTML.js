// @ts-check
import fs from 'fs';
import { escapeHtml } from '../lib/utils.js';
import { renderReportPage, doneScript, BASE_REPORT_CSS } from './htmlShared.js';
import { outputPath, ensureParentDir } from '../lib/paths.js';

/**
 * @typedef {{ locale: string, name: string }} LocaleName
 * @typedef {{ wdUri: string, qid: string, inatId: string, taxonName: string | null, missing: LocaleName[] }} NameItem
 */

const WD_DATE = `+${new Date().toISOString().slice(0, 10)}T00:00:00Z/11`;

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

/**
 * @param {NameItem[]} items
 * @param {string} [outputFile]
 * @returns {Promise<void>}
 */
export async function generateNamesHTML(items, outputFile = outputPath('names.html')) {
    if (items.length === 0) {
        console.log('No missing names found.');
        return;
    }

    const rows = items.map(buildRow).join('\n');

    const css = `${BASE_REPORT_CSS}
    .taxon-col { width: 14em; font-style: italic; font-size: 0.9em; }
    .inat-col { width: 7em; font-size: 0.85em; font-family: monospace; }
    .names-col { width: 18em; font-size: 0.85em; }
    .name-entry { display: block; line-height: 1.6; }
    .locale { display: inline-block; width: 4.5em; font-family: monospace;
              color: #666; font-size: 0.9em; }
    #aggregate-container { position: relative; margin-bottom: 1em; }`;

    const html = renderReportPage({
        title: 'Missing Vernacular Names',
        heading: `Missing Vernacular Names &mdash; ${items.length} items`,
        intro: 'Click QuickStatements text to copy. Paste into <a href="https://quickstatements.toolforge.org/" target="_blank">QuickStatements</a> to import.',
        css,
        aggregate: true,
        thead: `      <tr>
        <th class="check-col"></th>
        <th>Wikidata item</th>
        <th>Taxon name</th>
        <th>iNat taxon</th>
        <th>Missing names</th>
        <th>QuickStatements (click to copy)</th>
      </tr>`,
        rows,
        script: doneScript({ segment: 'names', aggregate: true }),
    });

    fs.writeFileSync(ensureParentDir(outputFile), html, 'utf8');
    console.log(`HTML written to ${outputFile} (${items.length} items)`);
}
