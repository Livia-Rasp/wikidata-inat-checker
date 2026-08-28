// The names worklist: open findings ready to confirm — iNat vernacular names missing from
// Wikidata's P1843. No review section: unlike links, a name finding has no ambiguity to resolve —
// every candidate already carries a confirmed inatId from a P3151-linked WD item, so the only
// question is which languages are missing, not which iNat taxon is meant.
//
// The worklist itself (paging, hide-done, the QuickStatements panel) is worklist.js's shared
// controller, configured for this kind — see its own header for why.

import { getJson, postJson } from './api.js';
import { buildNameQuickStatements } from './rows.js';
import { clientId } from './clientId.js';
import { mountShell } from './shell.js';
import { createWorklistPage } from './worklist.js';

mountShell('name');

// ---- QuickStatements panel: every open finding, batched ----
// Unlike links' auto-eligible subset (a taxonomic-confidence bar), a name finding has no
// confidence axis to gate on — every candidate's iNat match is already certain, so the panel
// simply batches every open finding, fetched independently of the paged worklist above.

/** Above the API's page-size ceiling but within its MAX_LIMIT, so one request is the whole
 *  practical backlog. */
const QS_FETCH_LIMIT = 2000;

async function pendingOpen() {
    const { taxa } = await getJson(
        `api/findings?kind=name&status=open&limit=${QS_FETCH_LIMIT}&clientId=${encodeURIComponent(clientId())}`);
    return taxa;
}

const page = createWorklistPage({
    kind: 'name',
    hideDoneKey: 'hide-done-names',
    postJson, getJson,
    qsLabel: 'every open finding',
    qsPlaceholder: 'Every open finding\'s missing names appear here automatically, one statement '
        + 'per language. Copy, run the batch, then Confirm pending.',
    fetchPending: pendingOpen,
    qsLines: (pending) => pending
        .filter((t) => t.inatTaxonId && t.payload?.missing?.length)
        .map((t) => buildNameQuickStatements(t.qid, t.inatTaxonId, t.payload.missing))
        .join('\n'),
    idsOf: (pending) => pending.map((t) => t.id),
    confirmMessage: (ok, total) => `${ok} of ${total} fully confirmed.`,
});

// ---- boot ----
page.load();
page.refreshQuickStatements();
