#!/usr/bin/env node
// @ts-check
// Generates a Commons category draft for one or more taxa, given just their Wikidata QIDs,
// using the same schema as the image checker. Handy when a draft's parent category (genus,
// family, …) doesn't exist on Commons yet and needs creating from scratch.
import { generateDraftWikitext } from './lib/generateWikitext.js';
import { extractTaxonName } from './report/htmlShared.js';
import { runMain, UsageError } from './lib/cli.js';

const ENTITY_URI = 'http://www.wikidata.org/entity/';

// Accept Q-numbers, "wd:Q123", or full entity URLs; keep only the first Q-id per token.
function parseQids() {
    const qids = process.argv.slice(2)
        .map(tok => (tok.match(/Q\d+/i) || [])[0])
        .filter(Boolean)
        .map(q => q.toUpperCase());
    if (qids.length === 0) {
        throw new UsageError('Usage: node draftCategory.js <QID> [<QID> …]',
            ['e.g. node draftCategory.js Q14625955   (genus Cornicandovia)']);
    }
    return qids;
}

async function run() {
    const qids = parseQids();
    /** @type {Record<string, true>} */
    const available = Object.fromEntries(qids.map(q => [ENTITY_URI + q, true]));
    const drafts = await generateDraftWikitext(available);

    for (const qid of qids) {
        const wikitext = drafts[ENTITY_URI + qid];
        if (!wikitext) {
            console.error(`No draft for ${qid} (not a taxon, or missing taxon name P225).`);
            continue;
        }
        const name = extractTaxonName(wikitext);
        console.log(`\n== Category:${name ?? qid} ==`);
        console.log(wikitext);
    }
}

runMain(run);
