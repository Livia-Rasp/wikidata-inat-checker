#!/usr/bin/env node
// @ts-check
// CLI wrapper: parse arguments, run a geographically-scoped discovery, render the area report. The
// work itself is lib/discover.js (recording, shared with every other scope) and
// lib/areaCandidates.js (the area-specific candidate list and photo/date enrichment) — see
// docs/dev.md.
import { discover, DiscoveryError } from './lib/discover.js';
import { resolveAreaScope, fetchAreaSpecies, fetchAreaCandidates, fetchAreaEnrichment } from './lib/areaCandidates.js';
import { generateAreaHTML } from './report/generateAreaHTML.js';
import { openFindingsDb } from './lib/db.js';
import { ensureTaxaDb } from './lib/getInatTaxaDb.js';
import { parseArgs } from './lib/utils.js';
import { findingsDbPath } from './lib/paths.js';
import { runMain, UsageError } from './lib/cli.js';

const DB_FILE = findingsDbPath();

const args = parseArgs();

/** @returns {{lat: number, lng: number, radius: number}} */
function parseArea() {
    try {
        const area = resolveAreaScope({ lat: args.lat, lng: args.lng, radius: args.radius });
        if (area) return area;
    } catch (err) {
        if (err instanceof DiscoveryError) throw new UsageError(err.message);
        throw err;
    }
    throw new UsageError('Usage: node checkArea.js --lat <lat> --lng <lng> --radius <km>',
        ['Example: node checkArea.js --lat 48.147 --lng 11.589 --radius 10']);
}

/** Turn discover()'s progress events back into the lines this tool has always printed. */
function report(p) {
    switch (p.phase) {
        case 'checking':
            if (p.taxa !== undefined) {
                if (p.alreadyKnown > 0) console.log(`Findings DB: skipped ${p.alreadyKnown} taxa already recorded.`);
                return console.log(`Checking ${p.taxa} taxa against iNat for CC0/CC-BY/CC-BY-SA photos...`);
            }
            if (p.batch % 5 === 0 || p.batch === p.batches) {
                console.log(`progress: batch ${p.batch}/${p.batches}, available so far: ${p.matched}`);
            }
            return;
        case 'done':
            return console.log(
                `Recorded: ${p.open} open, ${p.noDraft} with photos but no draft, ${p.noPhotos} without photos`
                + (p.failed ? `, ${p.failed} unanswered (will retry)` : '') + '.');
    }
}

async function run() {
    const area = parseArea();
    const taxaDb = await ensureTaxaDb();
    const store = openFindingsDb(DB_FILE);
    try {
        console.log(`Querying iNat for species within ${area.radius} km of ${area.lat}, ${area.lng}...`);
        const species = await fetchAreaSpecies(area);
        console.log(`iNat: ${species.size} species with research-grade observations in area`);

        console.log('Checking Wikidata for items without images...');
        // Materialized once: discover()'s candidateSource and the report both need the same list,
        // and building it spends a real SPARQL query — fetching it twice would double that cost
        // for no reason.
        const candidates = [];
        for await (const row of fetchAreaCandidates(area, { species })) candidates.push(row);
        console.log(`Wikidata: ${candidates.length} items in area lack an image`);

        if (candidates.length === 0) {
            console.log('Nothing to report — all taxa in this area already have Wikidata images.');
            return;
        }

        await discover({ store, taxaDb, scope: area, candidateSource: candidates, onProgress: report });

        console.log('Fetching sample observations and latest dates...');
        const { obsMap, latestDateMap } = await fetchAreaEnrichment(
            candidates.map((c) => c.inatId), area);

        generateAreaHTML({
            lat: area.lat, lng: area.lng, radius: area.radius,
            totalSpecies: species.size,
            qualified: candidates.map((c) => ({
                taxonId: c.inatId, taxonName: c.taxonName, commonName: c.commonName, count: c.count,
            })),
            noImage: new Map(candidates.map((c) => [c.inatId, { wdUri: c.wdUri, wdName: c.taxonName }])),
            obsMap,
            latestDateMap,
        });
    } finally {
        store.close();
    }
}

runMain(run);
