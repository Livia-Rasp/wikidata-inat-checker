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
 * @param {ReturnType<typeof import('./db.js').createFindingsStore>} store
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
    // Ambiguous discovery never wrote a single inat_id onto the taxa row — it didn't have one yet
    // — so the pick is what finally settles it. Without this the worklist row and the QS line
    // built from it would keep reading the taxa table's still-null inat_id.
    store.upsertTaxon({ qid: finding.qid, inatId: candidate.inatId, rank: candidate.rank });
    store.recordFinding({
        qid: finding.qid, kind: 'link', status: 'open',
        payload: { inatId: candidate.inatId, rank: candidate.rank, evidence, autoEligible: isAutoEligible(evidence) },
    });
    return { id, qid: finding.qid, picked: true };
}
