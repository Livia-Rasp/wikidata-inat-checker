// @ts-check
// The verification pass: reconciles the open backlog against live Wikidata.
//
// Wikidata is a wiki, so a finding can stop being work while it sits in the backlog — somebody
// else adds the image, or the item is merged away or deleted. Without this pass the reports keep
// offering that work forever.
//
// This reads the **Action API, never SPARQL**. WDQS is an eventually-consistent index whose lag is
// usually seconds and occasionally hours, and it fails in the worst way here: right after a
// QuickStatements batch it may not show the edit yet, so a re-check would report the image still
// missing and a second one would be added. wbgetentities reads the live database.
//
// `redirects=no` makes the API report a redirect exactly like a deleted entity. Since a merged item
// and a deleted one both become `gone`, that collapses both into one `missing` check — no
// requested-vs-returned id comparison needed. The trade-off, accepted: the record does not say which
// of the two happened, or where a merged item went.
import { fetchEntitiesBatched } from './utils.js';

/** @typedef {{ verified: number, fixedUpstream: string[], gone: string[], stillOpen: number }} VerifyResult */

/**
 * Re-check every open finding of `kind` against live Wikidata and record the outcome.
 *
 * @param {ReturnType<import('./db.js').createFindingsStore>} store
 * @param {{ kind?: string, limit?: number,
 *           fetchFn?: (qids: string[]) => Promise<object>,
 *           onProgress?: (done: number, total: number) => void }} [opts]
 * @returns {Promise<VerifyResult>}
 */
export async function verifyOpenFindings(store, opts = {}) {
    const { kind = 'image', limit, fetchFn, onProgress } = opts;

    const open = store.openFindings(kind);
    const qids = (limit ? open.slice(0, limit) : open).map(f => f.qid);

    /** @type {VerifyResult} */
    const result = { verified: qids.length, fixedUpstream: [], gone: [], stillOpen: 0 };
    if (qids.length === 0) return result;

    const entities = await fetchEntitiesBatched(qids, {
        props: 'claims|sitelinks',
        sitefilter: 'commonswiki',
        redirects: 'no',
        fetchFn,
    });

    for (const qid of qids) {
        const entity = entities[qid];

        // Absent from the response at all: treat like missing rather than silently skipping, so a
        // finding can never be stuck open because the API stopped mentioning its item.
        if (!entity || entity.missing !== undefined) {
            store.markVerified(qid, kind, { status: 'gone', resolution: { reason: 'missing' } });
            result.gone.push(qid);
            continue;
        }

        if ((entity.claims?.P18?.length ?? 0) > 0) {
            store.markVerified(qid, kind, {
                status: 'fixed_upstream',
                resolution: { reason: 'p18_present', file: imageFile(entity) },
            });
            result.fixedUpstream.push(qid);
            continue;
        }

        // Still genuinely missing an image: stays open, but record that we looked.
        store.markVerified(qid, kind);
        result.stillOpen++;
        onProgress?.(result.stillOpen + result.gone.length + result.fixedUpstream.length, qids.length);
    }

    return result;
}

/** The Commons filename of the first P18 value, for the record. */
function imageFile(entity) {
    return entity.claims?.P18?.[0]?.mainsnak?.datavalue?.value ?? null;
}
