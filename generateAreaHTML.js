// @ts-check
import fs from 'fs';
import { escapeHtml, qidFromUri } from './utils.js';

/**
 * @param {{
 *   lat: number, lng: number, radius: number,
 *   totalSpecies: number,
 *   qualified: {taxonId: string, taxonName: string, commonName: string, count: number}[],
 *   noImage: Map<string, {wdUri: string, wdName: string}>,
 *   obsMap: Map<string, {obsId: number, photoUrl: string}[]>,
 *   latestDateMap: Map<string, string>
 * }} opts
 * @param {string} [outputFile]
 */
export function generateAreaHTML({ lat, lng, radius, totalSpecies, qualified, noImage, obsMap, latestDateMap }, outputFile = 'area.html') {
    // Pre-sort by latest observation date descending (newest first); ties broken by count desc.
    const sorted = [...qualified].sort((a, b) => {
        const da = latestDateMap.get(a.taxonId) ?? '';
        const db = latestDateMap.get(b.taxonId) ?? '';
        if (db !== da) return db > da ? 1 : -1;
        return b.count - a.count;
    });

    const obsBaseUrl = `https://www.inaturalist.org/observations`
        + `?lat=${lat}&lng=${lng}&radius=${radius}&quality_grade=research&taxon_id=`;

    const rows = sorted.map(s => {
        const wd      = noImage.get(s.taxonId);
        const qid     = qidFromUri(wd.wdUri);
        const photos  = obsMap.get(s.taxonId) ?? [];
        const date    = latestDateMap.get(s.taxonId) ?? '';

        const displayName = wd.wdName || s.taxonName;
        const commonPart  = s.commonName ? ` <span class="common">${escapeHtml(s.commonName)}</span>` : '';

        const photoHtml = photos.length
            ? photos.map(p =>
                `<a href="https://www.inaturalist.org/observations/${p.obsId}" target="_blank">` +
                `<img src="${escapeHtml(p.photoUrl)}" alt="" loading="lazy"></a>`
              ).join('')
            : `<a class="no-photo" href="${escapeHtml(obsBaseUrl + s.taxonId)}" target="_blank">no photo found</a>`;

        return `  <tr data-count="${s.count}" data-date="${escapeHtml(date)}">
    <td class="taxon-cell"><a href="https://www.inaturalist.org/taxa/${s.taxonId}" target="_blank"><em>${escapeHtml(displayName)}</em></a>${commonPart}</td>
    <td class="wd-cell"><a href="${escapeHtml(wd.wdUri)}" target="_blank">${qid}</a></td>
    <td class="count-cell">${s.count}</td>
    <td class="date-cell">${escapeHtml(date)}</td>
    <td class="photos-cell">${photoHtml}</td>
  </tr>`;
    }).join('\n');

    const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>Area species — ${lat}, ${lng} (${radius} km)</title>
  <style>
    body { font-family: sans-serif; padding: 1.5em; color: #222; max-width: 1200px; }
    h1 { font-size: 1.2em; margin-bottom: 0.2em; }
    .subtitle { color: #555; font-size: 0.9em; margin-bottom: 1.2em; }
    table { border-collapse: collapse; width: 100%; }
    thead th {
      text-align: left; padding: 0.5em 0.75em;
      background: #f0f0f0; border-bottom: 2px solid #ccc;
      font-size: 0.85em; white-space: nowrap;
    }
    thead th.sortable { cursor: pointer; user-select: none; }
    thead th.sortable:hover { background: #e4e4e4; }
    thead th .indicator { font-size: 0.75em; margin-left: 0.3em; color: #666; }
    td { vertical-align: middle; padding: 0.4em 0.75em; border-bottom: 1px solid #e8e8e8; }
    tbody tr:last-child td { border-bottom: none; }
    .taxon-cell { font-size: 0.9em; }
    .taxon-cell a { color: #222; text-decoration: none; }
    .taxon-cell a:hover { text-decoration: underline; }
    .common { color: #666; font-size: 0.85em; }
    .wd-cell { font-family: monospace; font-size: 0.85em; white-space: nowrap; }
    .wd-cell a { color: #0645ad; }
    .count-cell { text-align: right; font-size: 0.85em; color: #555; white-space: nowrap; }
    .date-cell { font-size: 0.85em; color: #555; white-space: nowrap; font-variant-numeric: tabular-nums; }
    .photos-cell { white-space: nowrap; }
    .photos-cell img { width: 100px; height: 75px; object-fit: cover; border-radius: 3px;
                       border: 1px solid #ddd; vertical-align: middle; margin-right: 3px; }
    .photos-cell a:last-child img { margin-right: 0; }
    .photos-cell a:hover img { border-color: #5a5; opacity: 0.9; }
    .no-photo { font-size: 0.8em; color: #aaa; text-decoration: none; }
    .no-photo:hover { color: #0645ad; text-decoration: underline; }
  </style>
</head>
<body>
  <h1>Species missing Wikidata images — within ${radius} km of ${lat}°, ${lng}°</h1>
  <p class="subtitle">${sorted.length} of ${totalSpecies} species observed in area have a Wikidata item but no image (P18). Thumbnails link to iNat observations; "no photo found" links to all observations for that taxon in the area.</p>
  <table>
    <thead>
      <tr>
        <th>Taxon</th>
        <th>Wikidata</th>
        <th class="sortable" onclick="sortBy('count')">Obs.<span class="indicator" id="ind-count"></span></th>
        <th class="sortable" onclick="sortBy('date')">Latest obs.<span class="indicator" id="ind-date">▼</span></th>
        <th>Photos</th>
      </tr>
    </thead>
    <tbody>
${rows}
    </tbody>
  </table>
  <script>
    let sortCol = 'date', sortDir = -1;

    function sortBy(col) {
      if (sortCol === col) sortDir *= -1;
      else { sortCol = col; sortDir = -1; }
      const tbody = document.querySelector('tbody');
      const rows = [...tbody.rows].sort((a, b) => {
        const av = a.dataset[col], bv = b.dataset[col];
        if (col === 'count') return (parseInt(av) - parseInt(bv)) * sortDir;
        return (av < bv ? -1 : av > bv ? 1 : 0) * sortDir;
      });
      rows.forEach(r => tbody.appendChild(r));
      updateIndicators();
    }

    function updateIndicators() {
      document.getElementById('ind-count').textContent = sortCol === 'count' ? (sortDir === 1 ? '▲' : '▼') : '';
      document.getElementById('ind-date').textContent  = sortCol === 'date'  ? (sortDir === 1 ? '▲' : '▼') : '';
    }
  </script>
</body>
</html>`;

    fs.writeFileSync(outputFile, html, 'utf8');
    console.log(`HTML written to ${outputFile} (${sorted.length} taxa)`);
}
