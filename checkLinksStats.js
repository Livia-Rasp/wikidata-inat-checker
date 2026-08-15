#!/usr/bin/env node
// @ts-check
import { ensureTaxaDb } from './lib/getInatTaxaDb.js';
import { cirrusCount, fetchWdTaxaByNames, IUCN_STATUS_QIDS, IUCN_QID_TO_CODE } from './lib/utils.js';

const NO_STATUS = '(no IUCN status)';
const IUCN_ORDER = ['CR', 'EN', 'VU', 'NT', 'LC', 'DD', 'EX', 'EW', 'NE', NO_STATUS];
// All groups share: instance of taxon, has a scientific name, no iNat ID.
const BASE_FILTER = 'haswbstatement:P31=Q16521 haswbstatement:P225 -haswbstatement:P3151';

async function runStats() {
    console.log('Loading iNat taxa DB…');
    const taxaDb = await ensureTaxaDb();
    const names = taxaDb.allNames();
    console.log(`${names.length.toLocaleString()} distinct iNat names loaded.`);

    const groups = {};
    for (const code of IUCN_ORDER) groups[code] = { total: 0, match: 0, ambig: 0, none: 0 };

    // Phase 1: exact totals per bucket via CirrusSearch.
    // WDQS times out scanning the ~3M no-P3151 set (even COUNT); CirrusSearch is instant.
    console.log('\nFetching exact totals (CirrusSearch)…');
    for (const code of IUCN_ORDER) {
        const filter = code === NO_STATUS
            ? `${BASE_FILTER} -haswbstatement:P141`
            : `${BASE_FILTER} haswbstatement:P141=${IUCN_STATUS_QIDS[code]}`;
        groups[code].total = await cirrusCount(filter);
        console.log(`  ${code.padEnd(16)} ${groups[code].total.toLocaleString()}`);
    }

    // Phase 2: match/ambig by querying Wikidata *by iNat name* (bounded VALUES POST batches).
    // Every WD taxon name either is an iNat name (→ match/ambig) or isn't (→ no-match),
    // so this captures the full match+ambig population; no-match is derived from totals.
    console.log('\nClassifying matches (querying Wikidata by iNat name)…');
    const allByNameCache = new Map();
    const seen = new Set(); // dedup by (qid, iucnQid) — a taxon may carry multiple P141
    for await (const row of fetchWdTaxaByNames(names, {
        onBatch: (done, total) =>
            process.stdout.write(`  ${done.toLocaleString()} / ${total.toLocaleString()} names queried\r`),
    })) {
        const key = `${row.qid}|${row.iucnQid ?? ''}`;
        if (seen.has(key)) continue;
        seen.add(key);

        const code = row.iucnQid ? IUCN_QID_TO_CODE[row.iucnQid] : NO_STATUS;
        const g = code ? groups[code] : undefined; // unknown IUCN QID → outside the table
        if (!g) continue;

        const name = row.taxonName;
        if (taxaDb.get(name)) {
            g.match++;
        } else {
            if (!allByNameCache.has(name)) allByNameCache.set(name, taxaDb.getAll(name));
            if (allByNameCache.get(name).length >= 2) g.ambig++;
            // else: impossible — name came from the iNat DB, so getAll() is never empty
        }
    }
    console.log(''); // finish the \r progress line

    // Derive no-match: total minus the iNat-name matches/ambiguities.
    for (const code of IUCN_ORDER) {
        const g = groups[code];
        g.none = Math.max(0, g.total - g.match - g.ambig);
    }

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
        console.log(
            code.padEnd(W[0]) + '|' +
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
