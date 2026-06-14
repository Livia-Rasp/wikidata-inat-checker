// @ts-check
import fs from 'fs';
import { escapeHtml, qidFromUri } from './utils.js';

/**
 * @param {{
 *   lat: number, lng: number, radius: number,
 *   totalSpecies: number,
 *   qualified: {taxonId: string, taxonName: string, commonName: string, count: number}[],
 *   noImage: Map<string, {wdUri: string, wdName: string}>,
 *   obsMap: Map<string, {obsId: number, photoUrl: string}[]>
 * }} opts
 * @param {string} [outputFile]
 */
export function generateAreaHTML({ lat, lng, radius, totalSpecies, qualified, noImage, obsMap }, outputFile = 'area.html') {
    const rows = qualified.map(s => {
        const wd  = noImage.get(s.taxonId);
        const qid = qidFromUri(wd.wdUri);
        const photos = obsMap.get(s.taxonId) ?? [];

        const photoHtml = photos.length
            ? photos.map(p => `<a href="https://www.inaturalist.org/observations/${p.obsId}" target="_blank">` +
                `<img src="${escapeHtml(p.photoUrl)}" alt="" loading="lazy"></a>`).join('')
            : '<span class="no-photo">no photo found</span>';

        const displayName = wd.wdName || s.taxonName;
        const commonPart  = s.commonName ? ` <span class="common">${escapeHtml(s.commonName)}</span>` : '';

        return `  <div class="row">
    <div class="info">
      <div class="taxon-name">
        <a href="https://www.inaturalist.org/taxa/${s.taxonId}" target="_blank"><em>${escapeHtml(displayName)}</em></a>${commonPart}
      </div>
      <div class="meta">
        <a class="wd-link" href="${escapeHtml(wd.wdUri)}" target="_blank">${qid}</a>
        <span class="count">${s.count} obs. in area</span>
      </div>
    </div>
    <div class="photos">${photoHtml}</div>
  </div>`;
    }).join('\n');

    const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>Area species — ${lat}, ${lng} (${radius} km)</title>
  <style>
    body { font-family: sans-serif; padding: 1.5em; color: #222; max-width: 1100px; }
    h1 { font-size: 1.2em; margin-bottom: 0.2em; }
    .subtitle { color: #555; font-size: 0.9em; margin-bottom: 1.5em; }
    .row {
      display: flex; align-items: flex-start; gap: 1em;
      padding: 0.6em 0; border-bottom: 1px solid #e8e8e8;
    }
    .row:last-child { border-bottom: none; }
    .info { flex: 0 0 280px; }
    .taxon-name { font-size: 0.95em; margin-bottom: 0.2em; }
    .taxon-name a { color: #222; text-decoration: none; }
    .taxon-name a:hover { text-decoration: underline; }
    .common { color: #666; font-size: 0.88em; }
    .meta { font-size: 0.82em; color: #555; display: flex; gap: 0.8em; align-items: baseline; }
    .wd-link { font-family: monospace; color: #0645ad; }
    .count { color: #888; }
    .photos { display: flex; gap: 0.4em; flex-wrap: wrap; }
    .photos img { width: 120px; height: 90px; object-fit: cover; border-radius: 3px;
                  border: 1px solid #ddd; display: block; }
    .photos a:hover img { border-color: #5a5; opacity: 0.9; }
    .no-photo { font-size: 0.8em; color: #bbb; align-self: center; }
  </style>
</head>
<body>
  <h1>Species missing Wikidata images — within ${radius} km of ${lat}°, ${lng}°</h1>
  <p class="subtitle">${qualified.length} of ${totalSpecies} iNat species in area have a Wikidata item but no image (P18). Thumbnails link to iNat observations; names link to iNat taxon pages.</p>
${rows}
</body>
</html>`;

    fs.writeFileSync(outputFile, html, 'utf8');
    console.log(`HTML written to ${outputFile} (${qualified.length} taxa)`);
}
