#!/usr/bin/env node
// @ts-check
import { loadTaxaDb } from './getInatTaxaDb.js';
import { sparqlTSV, IUCN_STATUS_QIDS } from './utils.js';

const IUCN_ORDER = ['CR', 'EN', 'VU', 'NT', 'LC', 'DD', 'EX', 'EW', 'NE', '(no IUCN status)'];
const PAGE_SIZE = 25000;

/**
 * Classify taxon names against the iNat DB and accumulate counts into a group bucket.
 * @param {{ total:number, match:number, ambig:number, none:number }} g
 * @param {string[]} names
 * @param {object} taxaDb
 * @param {Map<string, object[]>} allByNameCache
 */
function classifyInto(g, names, taxaDb, allByNameCache) {
    for (const name of names) {
        g.total++;
        if (taxaDb.get(name)) { g.match++; continue; }
        if (!allByNameCache.has(name)) allByNameCache.set(name, taxaDb.getAll(name));
        if (allByNameCache.get(name).length >= 2) g.ambig++;
        else g.none++;
    }
}

async function runStats() {
    console.log('Loading iNat taxa DB…');
    const taxaDb = await loadTaxaDb();

    const allByNameCache = new Map();
    const groups = {};
    for (const code of IUCN_ORDER) groups[code] = { total: 0, match: 0, ambig: 0, none: 0 };

    // Phase 1: one query per IUCN status — small result sets, no pagination needed
    console.log('\nFetching IUCN-coded taxa…');
    for (const [code, statusQid] of Object.entries(IUCN_STATUS_QIDS)) {
        process.stdout.write(`  ${code}…`);
        const rows = await sparqlTSV(`SELECT ?item ?taxonName WHERE {
  ?item wdt:P31 wd:Q16521 .
  ?item wdt:P225 ?taxonName .
  ?item wdt:P141 wd:${statusQid} .
  FILTER NOT EXISTS { ?item wdt:P3151 ?any . }
} LIMIT 50000`);
        const seen = new Set();
        const names = [];
        for (const b of rows) {
            if (!b.item || seen.has(b.item)) continue;
            seen.add(b.item);
            names.push(b.taxonName ?? '');
        }
        classifyInto(groups[code], names, taxaDb, allByNameCache);
        console.log(` ${seen.size.toLocaleString()} taxa`);
    }

    // Phase 2: paginate items with no P141 at all
    console.log('\nFetching taxa without IUCN status (paginated)…');
    const g = groups['(no IUCN status)'];
    let offset = 0, page = 0, partial = false;
    const seenNoStatus = new Set();
    while (true) {
        page++;
        process.stdout.write(`  Page ${page} (offset ${offset.toLocaleString()})…`);
        let rows;
        try {
            rows = await sparqlTSV(`SELECT ?item ?taxonName WHERE {
  ?item wdt:P31 wd:Q16521 .
  ?item wdt:P225 ?taxonName .
  FILTER NOT EXISTS { ?item wdt:P3151 ?any . }
  FILTER NOT EXISTS { ?item wdt:P141 ?any . }
} LIMIT ${PAGE_SIZE} OFFSET ${offset}`);
        } catch (err) {
            console.log(`\nWarning: stopped at offset ${offset.toLocaleString()} after ${page - 1} page(s): ${err.message}`);
            partial = true;
            break;
        }
        const names = [];
        for (const b of rows) {
            if (!b.item || seenNoStatus.has(b.item)) continue;
            seenNoStatus.add(b.item);
            names.push(b.taxonName ?? '');
        }
        classifyInto(g, names, taxaDb, allByNameCache);
        console.log(` ${rows.length} rows, ${seenNoStatus.size.toLocaleString()} unique so far`);
        if (rows.length < PAGE_SIZE) break;
        offset += PAGE_SIZE;
        await new Promise(r => setTimeout(r, 2000));
    }
    if (partial) console.log(`Warning: no-IUCN-status group is incomplete (timed out at offset ${offset.toLocaleString()}).`);

    const col = (n, w) => n.toLocaleString().padStart(w);
    const W = [16, 8, 8, 8, 10];
    const sep = W.map(w => '-'.repeat(w + 1)).join('+');
    const header = 'Status'.padEnd(W[0]) + '|' + ' Total'.padStart(W[1]) + ' |' + ' Match'.padStart(W[2]) + ' |' + ' Ambig'.padStart(W[3]) + ' |' + ' No match'.padStart(W[4]);
    console.log('\nIUCN stats — Wikidata taxa without P3151');
    console.log('='.repeat(header.length));
    console.log(header);
    console.log(sep);

    let totTotal = 0, totMatch = 0, totAmbig = 0, totNone = 0;
    for (const code of IUCN_ORDER) {
        const g = groups[code];
        if (!g || g.total === 0) continue;
        const suffix = code === '(no IUCN status)' && partial ? ' (incomplete)' : '';
        console.log(
            (code + suffix).padEnd(W[0] + suffix.length) + '|' +
            col(g.total, W[1]) + ' |' +
            col(g.match, W[2]) + ' |' +
            col(g.ambig, W[3]) + ' |' +
            col(g.none,  W[4])
        );
        totTotal += g.total; totMatch += g.match; totAmbig += g.ambig; totNone += g.none;
    }
    console.log(sep);
    console.log(
        'TOTAL'.padEnd(W[0]) + '|' +
        col(totTotal, W[1]) + ' |' +
        col(totMatch, W[2]) + ' |' +
        col(totAmbig, W[3]) + ' |' +
        col(totNone,  W[4])
    );
}

runStats().catch(err => { console.error('Fatal error:', err); process.exit(1); });
