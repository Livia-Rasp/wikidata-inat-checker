// @ts-check
// Picking a candidate out of an ambiguous link finding — a purely local decision, no Wikidata
// call involved, which is what tells this apart from confirm.js and lib/verify.js. Kept as its
// own file rather than folded into confirm.js for the same reason discoverLinks.js is its own
// file: a different question, not a variant of an existing one.
import { isAutoEligible } from './discoverLinks.js';

/**
 * @typedef {{ id: number, qid: string, picked: boolean, reason?: string }} PickResult
 */

/**
 * Record which candidate a human chose for an `ambiguous` link finding, re-recording it as
 * `open` via {@link recordFinding} rather than {@link markVerified} — this is a fresh candidacy
 * with a real payload the confirm flow needs (inatId, rank, evidence, autoEligible), not a
 * "still true" observation, and it never asked Wikidata anything.
 * @param {ReturnType<import('./db.js').createFindingsStore>} store
 * @param {number} id
 * @param {string} inatId
 * @returns {PickResult}
 */
export function pickCandidate(store, id, inatId) {
    const finding = store.getFinding(id);
    if (!finding) return { id, qid: '', picked: false, reason: 'not_found' };
    if (finding.kind !== 'link' || finding.status !== 'ambiguous') {
        return { id, qid: finding.qid, picked: false, reason: 'not_ambiguous' };
    }

    const candidate = (finding.payload?.candidates ?? []).find((c) => c.inatId === inatId);
    if (!candidate) return { id, qid: finding.qid, picked: false, reason: 'unknown_candidate' };

    const evidence = candidate.evidence ?? { matches: 0, mismatches: 0, matchedRanks: [] };
    store.recordFinding({
        qid: finding.qid, kind: 'link', status: 'open',
        payload: { inatId: candidate.inatId, rank: candidate.rank, evidence, autoEligible: isAutoEligible(evidence) },
    });
    return { id, qid: finding.qid, picked: true };
}
