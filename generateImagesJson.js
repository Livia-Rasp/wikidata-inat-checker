// @ts-check
import fs from 'fs';
import path from 'path';
import { qidFromUri } from './utils.js';
import { extractTaxonName } from './htmlShared.js';

/**
 * Exports the image-checker results as the data contract consumed by the web/ app.
 * Each entry carries everything the app needs without any further core dependency:
 * the Wikidata QID/URI, the iNat taxon ID (for the photo gallery query), the taxon
 * name (so the upload's [[Category:<Taxon>]] matches the drafted category), and the
 * draft category Wikitext (so the main view can show/copy it like drafts.html).
 *
 * @param {Record<string, string>} drafts - wdUri → Commons category Wikitext draft
 * @param {Record<string, string>} inatTaxonIds - wdUri → iNat taxon ID
 * @param {string} [outFile]
 * @returns {void}
 */
export function generateImagesJson(drafts, inatTaxonIds, outFile = 'web/data/taxa.json') {
    const taxa = Object.entries(drafts).map(([wdUri, wikitext]) => ({
        qid: qidFromUri(wdUri),
        wdUri,
        inatTaxonId: inatTaxonIds[wdUri] ?? null,
        taxonName: extractTaxonName(wikitext),
        wikitext,
    }));

    const payload = { generated: new Date().toISOString(), taxa };

    fs.mkdirSync(path.dirname(outFile), { recursive: true });
    fs.writeFileSync(outFile, JSON.stringify(payload, null, 2), 'utf8');
    console.log(`JSON written to ${outFile} (${taxa.length} taxa)`);
}
