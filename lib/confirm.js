// @ts-check
// Confirmation: "did the edit I just made actually land?"
//
// Kept apart from lib/verify.js because the two ask different questions of the same API response.
// The verification pass asks "does this taxon still need an image?", so anybody's P18 resolves it.
// A confirm asks "did *my* edit land in full?", and this app emits two statements per taxon — the
// image (P18) and the Commons-category sitelink — so both must be live before a finding is done.
// Confirming on P18 alone would quietly mark a half-applied QuickStatements batch complete.
//
// Nothing is marked done on the strength of a copied QuickStatements line that may never have been
// pasted; that gap is the whole reason this slice exists. A finding that fails to confirm is a
// no-op — it keeps `open` and only `verified_at` moves — never an error state.
import { fetchEntitiesBatched } from './utils.js';
import { readImageFacts, readLinkFacts, readNameFacts } from './verify.js';

/**
 * @typedef {{ id: number, qid: string, status: string, confirmed: boolean,
 *             reason: string, image?: string|null, commonsCategory?: string|null,
 *             expectedFile?: string|null }} ConfirmResult
 */

/** Why a confirm did not succeed. `not_found` and `gone` are about the item, the rest about edits. */
const MISSING_BOTH = 'missing_p18_and_sitelink';

/**
 * Resolve ids to their stored findings, shared by all three `confirm*Findings` predicates below.
 * An unknown id must say so: `markVerified` is keyed on (qid, kind) and silently updates zero
 * rows, so trusting it for a missing finding would report a successful confirm of nothing — so a
 * `not_found` result is pushed onto `results` in place rather than the id being dropped.
 * @param {ReturnType<typeof import('./db.js').createFindingsStore>} store
 * @param {number[]} ids
 * @param {ConfirmResult[]} results appended to in place, for ids with no finding
 * @returns {any[]} the findings that do exist
 */
function resolveFindings(store, ids, results) {
    const findings = [];
    for (const id of ids) {
        const finding = store.getFinding(id);
        if (!finding) {
            results.push({ id, qid: '', status: 'unknown', confirmed: false, reason: 'not_found' });
            continue;
        }
        findings.push(finding);
    }
    return findings;
}

/**
 * Confirm findings by id against live Wikidata, marking `done` only what is verifiably complete.
 *
 * Bulk by construction: `fetchEntitiesBatched` sends 50 QIDs per request, so confirming a whole
 * QuickStatements batch costs one round trip rather than one per taxon — which matters because the
 * budget being spent is Wikimedia's.
 *
 * @param {ReturnType<typeof import('./db.js').createFindingsStore>} store
 * @param {number[]} ids
 * @param {{ fetchFn?: (qids: string[]) => Promise<object>, log?: {warn: Function} }} [opts]
 * @returns {Promise<ConfirmResult[]>} one result per requested id, in the order asked
 */
export async function confirmFindings(store, ids, opts = {}) {
    /** @type {ConfirmResult[]} */
    const results = [];
    const findings = resolveFindings(store, ids, results);
    if (findings.length === 0) return results;

    const picks = store.p18Picks();
    const entities = await fetchEntitiesBatched(findings.map(f => f.qid), {
        props: 'claims|sitelinks',
        sitefilter: 'commonswiki',
        redirects: 'no',
        fetchFn: opts.fetchFn,
        log: opts.log,
    });

    for (const finding of findings) {
        const { id, qid, kind } = finding;
        const facts = readImageFacts(entities[qid]);
        const expectedFile = picks[qid]?.destFile ?? null;

        if (facts.missing) {
            store.markVerified(qid, kind, { status: 'gone', resolution: { reason: 'missing' } });
            results.push({ id, qid, status: 'gone', confirmed: false, reason: 'gone' });
            continue;
        }

        if (facts.image && facts.commonsCategory) {
            store.markVerified(qid, kind, {
                status: 'done',
                resolution: {
                    reason: 'confirmed',
                    file: facts.image,
                    sitelink: facts.commonsCategory,
                    // What was picked, alongside what is actually live: if an edit used a different
                    // image than the one chosen here, that is worth being able to see later.
                    expectedFile,
                },
            });
            store.clearP18Pick(qid);
            results.push({
                id, qid, status: 'done', confirmed: true, reason: 'confirmed',
                image: facts.image, commonsCategory: facts.commonsCategory, expectedFile,
            });
            continue;
        }

        // Incomplete. Record that we looked and change nothing else — in particular not the stored
        // draft wikitext, which markVerified is deliberately narrow enough to preserve.
        store.markVerified(qid, kind);
        results.push({
            id, qid, status: finding.status, confirmed: false,
            reason: !facts.image && !facts.commonsCategory ? MISSING_BOTH
                : !facts.image ? 'missing_p18'
                    : 'missing_sitelink',
            image: facts.image,
            commonsCategory: facts.commonsCategory,
            expectedFile,
        });
    }

    return results;
}

/**
 * Confirm link findings by id: the finding *is* a proposed P3151 statement, one property, no
 * sitelink pairing and no upload/pick bookkeeping — a link-shaped predicate, not a generalisation
 * of {@link confirmFindings}'s P18-plus-sitelink one, because "what counts as complete" genuinely
 * differs in shape here, not just which property is read.
 * @param {ReturnType<typeof import('./db.js').createFindingsStore>} store
 * @param {number[]} ids
 * @param {{ fetchFn?: (qids: string[]) => Promise<object>, log?: {warn: Function} }} [opts]
 * @returns {Promise<ConfirmResult[]>}
 */
export async function confirmLinkFindings(store, ids, opts = {}) {
    /** @type {ConfirmResult[]} */
    const results = [];
    const findings = resolveFindings(store, ids, results);
    if (findings.length === 0) return results;

    const entities = await fetchEntitiesBatched(findings.map(f => f.qid), {
        props: 'claims', redirects: 'no', fetchFn: opts.fetchFn, log: opts.log,
    });

    for (const finding of findings) {
        const { id, qid, kind } = finding;
        const facts = readLinkFacts(entities[qid]);

        if (facts.missing) {
            store.markVerified(qid, kind, { status: 'gone', resolution: { reason: 'missing' } });
            results.push({ id, qid, status: 'gone', confirmed: false, reason: 'gone' });
            continue;
        }

        if (facts.p3151) {
            store.markVerified(qid, kind, {
                status: 'done', resolution: { reason: 'confirmed', inatId: facts.p3151 },
            });
            results.push({ id, qid, status: 'done', confirmed: true, reason: 'confirmed' });
            continue;
        }

        store.markVerified(qid, kind);
        results.push({ id, qid, status: finding.status, confirmed: false, reason: 'missing_p3151' });
    }

    return results;
}

/**
 * Confirm name findings by id: a finding proposes several P1843 statements at once (one per
 * missing locale), so "complete" is not one property's presence but every proposed locale's —
 * genuinely different in shape from both {@link confirmFindings} and {@link confirmLinkFindings},
 * not a generalisation of either. All-resolved is `done`; partially-resolved trims payload to
 * what's still missing and stays `open` (a fresh, smaller candidacy — {@link
 * import('./db.js').createFindingsStore#recordFinding}, not `markVerified`, which must not touch
 * payload); none-resolved is a no-op, same as every other kind's confirm.
 *
 * Response fields are constrained to what `confirmResultSchema` (server/routes/findings.js)
 * declares — Fastify's serializer silently drops anything else — so the partial-vs-none
 * distinction lives only in `reason`, and the app re-fetches the row to see a trimmed
 * `payload.missing`.
 * @param {ReturnType<typeof import('./db.js').createFindingsStore>} store
 * @param {number[]} ids
 * @param {{ fetchFn?: (qids: string[]) => Promise<object>, log?: {warn: Function} }} [opts]
 * @returns {Promise<ConfirmResult[]>}
 */
export async function confirmNameFindings(store, ids, opts = {}) {
    /** @type {ConfirmResult[]} */
    const results = [];
    const findings = resolveFindings(store, ids, results);
    if (findings.length === 0) return results;

    const entities = await fetchEntitiesBatched(findings.map(f => f.qid), {
        props: 'claims', redirects: 'no', fetchFn: opts.fetchFn, log: opts.log,
    });

    for (const finding of findings) {
        const { id, qid, kind, payload } = finding;
        const facts = readNameFacts(entities[qid]);

        if (facts.missing) {
            store.markVerified(qid, kind, { status: 'gone', resolution: { reason: 'missing' } });
            results.push({ id, qid, status: 'gone', confirmed: false, reason: 'gone' });
            continue;
        }

        const stillMissing = payload.missing.filter(
            m => !facts.names.has(`${m.locale}:${m.name.toLowerCase()}`));

        if (stillMissing.length === 0) {
            store.markVerified(qid, kind, {
                status: 'done',
                resolution: { reason: 'confirmed', locales: payload.missing.map(m => m.locale) },
            });
            results.push({ id, qid, status: 'done', confirmed: true, reason: 'confirmed' });
            continue;
        }

        if (stillMissing.length < payload.missing.length) {
            store.recordFinding({ qid, kind, status: 'open', payload: { missing: stillMissing } });
            results.push({ id, qid, status: 'open', confirmed: false, reason: 'partially_confirmed' });
            continue;
        }

        store.markVerified(qid, kind);
        results.push({ id, qid, status: finding.status, confirmed: false, reason: 'missing_names' });
    }

    return results;
}

/**
 * Confirm a mixed batch of ids by dispatching each to its finding's own kind. A bulk confirm's
 * ids can span kinds (the app's QuickStatements panel confirms whatever the operator just
 * pasted), so this groups by kind, runs each kind's predicate once, and re-assembles results in
 * the order requested — the route layer stays kind-agnostic, only this dispatch knows kinds exist.
 * @param {ReturnType<typeof import('./db.js').createFindingsStore>} store
 * @param {number[]} ids
 * @param {{ fetchFn?: (qids: string[]) => Promise<object>, log?: {warn: Function} }} [opts]
 * @returns {Promise<ConfirmResult[]>}
 */
export async function confirmByKind(store, ids, opts = {}) {
    /** @type {Map<string, number[]>} */
    const byKind = new Map();
    /** @type {Map<number, ConfirmResult>} */
    const resultsById = new Map();

    for (const id of ids) {
        const finding = store.getFinding(id);
        if (!finding) {
            resultsById.set(id, { id, qid: '', status: 'unknown', confirmed: false, reason: 'not_found' });
            continue;
        }
        if (!byKind.has(finding.kind)) byKind.set(finding.kind, []);
        /** @type {number[]} */ (byKind.get(finding.kind)).push(id);
    }

    for (const [kind, kindIds] of byKind) {
        const run = kind === 'link' ? confirmLinkFindings
            : kind === 'name' ? confirmNameFindings
                : confirmFindings;
        for (const result of await run(store, kindIds, opts)) resultsById.set(result.id, result);
    }

    return ids.map((id) => /** @type {ConfirmResult} */ (resultsById.get(id)));
}
