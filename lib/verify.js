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
import { isAutoEligible } from './discoverLinks.js';

/** @typedef {{ verified: number, fixedUpstream: string[], gone: string[], stillOpen: number }} VerifyResult */

/**
 * Re-check every open finding of `kind` against live Wikidata and record the outcome. `kind:
 * 'link'` dispatches to {@link verifyLinkFindings} — its predicate (P3151, not P18/sitelink) and
 * its extra conflict-reverification pass are genuinely different in shape, not just which
 * property is read.
 *
 * @param {ReturnType<import('./db.js').createFindingsStore>} store
 * @param {{ kind?: string, limit?: number,
 *           fetchFn?: (qids: string[]) => Promise<object>,
 *           onProgress?: (done: number, total: number) => void }} [opts]
 * @returns {Promise<VerifyResult>}
 */
export async function verifyOpenFindings(store, opts = {}) {
    const { kind = 'image', limit, fetchFn, onProgress } = opts;
    if (kind === 'link') return verifyLinkFindings(store, { limit, fetchFn, onProgress });

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

/**
 * What a wbgetentities entity says about P3151, as a plain fact with no verdict — mirrors
 * {@link readImageFacts}. No sitelink half here: a link finding proposes exactly one statement,
 * so P3151 presence alone is the predicate, with no confirm/verify asymmetry to preserve.
 * @param {any} entity
 * @returns {{ missing: boolean, p3151: string|null }}
 */
export function readLinkFacts(entity) {
    if (!entity || entity.missing !== undefined) return { missing: true, p3151: null };
    return { missing: false, p3151: entity.claims?.P3151?.[0]?.mainsnak?.datavalue?.value ?? null };
}

/**
 * Re-check every `open` **and `conflict`** link finding. A conflict's fate depends on an item
 * this finding doesn't own — whoever currently holds the disputed iNat id — so that item is
 * fetched too, and a conflict whose competing claim has vanished or moved on is re-recorded as
 * `open` via {@link recordFinding}, the same "re-check upserts in place" path a negative status's
 * recheck-window expiry already uses, rather than {@link markVerified} — this is a fresh
 * candidacy, not a "still true" observation, so `resolved_at`/`resolution` (terminal-state
 * columns) must not be stamped on a row that is, again, actionable.
 * @param {ReturnType<import('./db.js').createFindingsStore>} store
 * @param {{ limit?: number, fetchFn?: (qids: string[]) => Promise<object>,
 *           onProgress?: (done: number, total: number) => void }} opts
 * @returns {Promise<VerifyResult>}
 */
async function verifyLinkFindings(store, { limit, fetchFn, onProgress }) {
    const candidates = [
        ...store.listFindings({ kind: 'link', status: 'open' }),
        ...store.listFindings({ kind: 'link', status: 'conflict' }),
    ];
    const rows = limit ? candidates.slice(0, limit) : candidates;

    /** @type {VerifyResult} */
    const result = { verified: rows.length, fixedUpstream: [], gone: [], stillOpen: 0 };
    if (rows.length === 0) return result;

    // Every row's own item, plus — for conflicts — whichever item currently holds the disputed
    // iNat id, which is a different QID entirely.
    const qidsToFetch = new Set(rows.map(r => r.qid));
    for (const r of rows) {
        if (r.status === 'conflict' && r.payload?.existingWdItem) qidsToFetch.add(r.payload.existingWdItem);
    }
    const entities = await fetchEntitiesBatched([...qidsToFetch], { props: 'claims', redirects: 'no', fetchFn });

    let checked = 0;
    for (const row of rows) {
        const own = readLinkFacts(entities[row.qid]);

        if (own.missing) {
            store.markVerified(row.qid, 'link', { status: 'gone', resolution: { reason: 'missing' } });
            result.gone.push(row.qid);
        } else if (own.p3151) {
            // Some P3151 statement exists now, whatever proposed it — this finding's job is done,
            // the same "presence alone resolves it" asymmetry images' verify already has.
            store.markVerified(row.qid, 'link', {
                status: 'fixed_upstream', resolution: { reason: 'p3151_present', inatId: own.p3151 },
            });
            result.fixedUpstream.push(row.qid);
        } else if (row.status === 'conflict') {
            const existingQid = row.payload?.existingWdItem;
            const existing = existingQid ? readLinkFacts(entities[existingQid]) : { missing: true, p3151: null };
            const stillClaimed = !existing.missing && existing.p3151 === row.inatTaxonId;
            if (stillClaimed) {
                store.markVerified(row.qid, 'link'); // still conflicting; just refresh verified_at
            } else {
                store.recordFinding({
                    qid: row.qid, kind: 'link', status: 'open',
                    payload: {
                        inatId: row.payload.inatId, rank: row.payload.rank, evidence: row.payload.evidence,
                        autoEligible: isAutoEligible(row.payload.evidence),
                    },
                });
            }
            result.stillOpen++;
        } else {
            store.markVerified(row.qid, 'link');
            result.stillOpen++;
        }
        checked++;
        onProgress?.(checked, rows.length);
    }

    return result;
}
