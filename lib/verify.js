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
        const facts = readImageFacts(entities[qid]);

        if (facts.missing) {
            store.markVerified(qid, kind, { status: 'gone', resolution: { reason: 'missing' } });
            result.gone.push(qid);
            continue;
        }

        // Deliberately P18 alone, and deliberately *not* the same test as a confirm: this pass
        // answers "does this still need an image?", so somebody else's image resolves it whether
        // or not a Commons category exists. See docs/dev.md on the asymmetry.
        if (facts.image) {
            store.markVerified(qid, kind, {
                status: 'fixed_upstream',
                resolution: { reason: 'p18_present', file: facts.image },
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

/**
 * What a wbgetentities entity says about the image question, as plain facts with no verdict —
 * the verdict differs between the batch pass (P18 is enough) and a confirm (the Commons sitelink
 * must be there too), so the two must not share one.
 *
 * An entity absent from the response is treated exactly like a `missing` one, so a finding can
 * never be stuck open because the API stopped mentioning its item.
 *
 * @param {any} entity
 * @returns {{ missing: boolean, image: string|null, commonsCategory: string|null }}
 */
export function readImageFacts(entity) {
    if (!entity || entity.missing !== undefined) {
        return { missing: true, image: null, commonsCategory: null };
    }
    return {
        missing: false,
        image: entity.claims?.P18?.[0]?.mainsnak?.datavalue?.value ?? null,
        commonsCategory: entity.sitelinks?.commonswiki?.title ?? null,
    };
}
