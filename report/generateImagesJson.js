// @ts-check
import fs from 'fs';
import path from 'path';

/**
 * Exports the open image backlog as the data contract consumed by the web/ app.
 * Each entry carries everything the app needs without any further core dependency:
 * the Wikidata QID/URI, the iNat taxon ID (for the photo gallery query), the taxon
 * name (so the upload's [[Category:<Taxon>]] matches the drafted category), and the
 * draft category Wikitext (so the main view can show/copy it like drafts.html).
 *
 * Like drafts.html this renders the whole accumulated worklist from the findings database, not
 * just the taxa the current run discovered, so re-running the checker grows the app's list
 * instead of replacing it.
 *
 * @param {import('../lib/db.js').FindingRow[]} findings
 * @param {string} [outFile]
 * @returns {void}
 */
export function generateImagesJson(findings, outFile = 'web/data/taxa.json') {
    // iucn rides along so the app can subselect the backlog by threat category later.
    const taxa = findings.map(({ qid, wdUri, inatTaxonId, taxonName, iucn, wikitext }) => ({
        qid,
        wdUri,
        inatTaxonId,
        taxonName,
        iucn,
        wikitext,
    }));

    const payload = { generated: new Date().toISOString(), taxa };

    fs.mkdirSync(path.dirname(outFile), { recursive: true });
    fs.writeFileSync(outFile, JSON.stringify(payload, null, 2), 'utf8');
    console.log(`JSON written to ${outFile} (${taxa.length} taxa)`);
}
