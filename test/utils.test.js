// @ts-check
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    chunk, qidFromUri, escapeHtml, compareAncestorTrees, fetchWdAncestorChains,
    parseArgs, parseLimit, parseIucnArg, shuffle,
    IUCN_STATUS_QIDS, IUCN_QID_TO_CODE,
    reqInit, HEADERS, FETCH_TIMEOUT_MS, SPARQL_TIMEOUT_MS,
    fetchWithRetry,
} from '../lib/utils.js';
import { UsageError } from '../lib/cli.js';

/** Records every call, keyed by level, without doing anything else. */
function fakeLog() {
    const calls = { warn: [], error: [] };
    return { calls, warn: (...a) => calls.warn.push(a), error: (...a) => calls.error.push(a) };
}

/** fetchWithRetry only ever reads `.status`/`.ok`, so a plain object stands in for a Response. */
function fakeResponse(status, ok) {
    return /** @type {Response} */ ({ status, ok });
}

test('chunk splits into fixed-size groups, remainder last', () => {
    assert.deepEqual(chunk([1, 2, 3, 4, 5], 2), [[1, 2], [3, 4], [5]]);
    assert.deepEqual(chunk([], 3), []);
    assert.deepEqual(chunk([1, 2], 5), [[1, 2]]);
});

test('qidFromUri takes the last path segment', () => {
    assert.equal(qidFromUri('http://www.wikidata.org/entity/Q42'), 'Q42');
    assert.equal(qidFromUri('Q7'), 'Q7');
});

test('escapeHtml escapes the five markup-significant characters', () => {
    assert.equal(escapeHtml('<a href="x">&'), '&lt;a href=&quot;x&quot;&gt;&amp;');
    assert.equal(escapeHtml(42), '42');
});

test('parseArgs: --key value, --key=value, and bare --flag', () => {
    assert.deepEqual(parseArgs(['--limit', '500']), { limit: '500' });
    assert.deepEqual(parseArgs(['--limit=500']), { limit: '500' });
    assert.deepEqual(parseArgs(['--auto']), { auto: true });
    assert.deepEqual(parseArgs(['--taxon', 'Orchidaceae', '--iucn', 'CR']),
        { taxon: 'Orchidaceae', iucn: 'CR' });
    assert.deepEqual(parseArgs(['--iucn=cr']), { iucn: 'cr' });
});

test('parseArgs: a flag followed by another flag stays boolean', () => {
    assert.deepEqual(parseArgs(['--all', '--limit', '10']), { all: true, limit: '10' });
});

test('parseArgs: positional tokens are ignored; --key= yields empty string', () => {
    assert.deepEqual(parseArgs(['pos', '--flag']), { flag: true });
    assert.deepEqual(parseArgs(['--name=']), { name: '' });
});

test('parseArgs: --key=value keeps = signs inside the value', () => {
    assert.deepEqual(parseArgs(['--q=a=b=c']), { q: 'a=b=c' });
});

test('parseLimit: positive integer or fallback', () => {
    assert.equal(parseLimit({ limit: '500' }, 5000), 500);
    assert.equal(parseLimit({}, 5000), 5000);
    assert.equal(parseLimit({ limit: true }, 5000), 5000);   // bare --limit flag
    assert.equal(parseLimit({ limit: '0' }, 5000), 5000);    // not > 0
    assert.equal(parseLimit({ limit: '-3' }, 5000), 5000);
    assert.equal(parseLimit({ limit: 'abc' }, 5000), 5000);
});

test('shuffle: same seed produces the same order every call', () => {
    const input = Array.from({ length: 50 }, (_, i) => i);
    assert.deepEqual(shuffle(input, 42), shuffle(input, 42));
});

test('shuffle: output is a permutation of the input, input left untouched', () => {
    const input = Array.from({ length: 20 }, (_, i) => i);
    const out = shuffle(input, 7);
    assert.deepEqual(input, Array.from({ length: 20 }, (_, i) => i)); // not mutated
    assert.equal(out.length, input.length);
    assert.deepEqual([...out].sort((a, b) => a - b), input);
});

test('shuffle: different seeds produce different orders', () => {
    const input = Array.from({ length: 50 }, (_, i) => i);
    assert.notDeepEqual(shuffle(input, 1), shuffle(input, 2));
});

test('parseIucnArg: uppercases the code and maps to a QID', () => {
    assert.deepEqual(parseIucnArg({ iucn: 'cr' }), { iucnArg: 'CR', iucnQid: IUCN_STATUS_QIDS.CR });
    assert.deepEqual(parseIucnArg({}), { iucnArg: null, iucnQid: null });
    assert.deepEqual(parseIucnArg({ iucn: true }), { iucnArg: null, iucnQid: null }); // bare --iucn
});

test('parseIucnArg: an unknown code throws a usage error, and does not exit', () => {
    // It used to call process.exit, which this test had to stub to observe at all — a library
    // killing the process is only survivable where the process is disposable. Now it throws and
    // runMain owns the exit.
    assert.throws(() => parseIucnArg({ iucn: 'ZZ' }), (err) => {
        assert.ok(err instanceof UsageError);
        assert.equal(err.expected, true);
        assert.match(err.message, /ZZ/);
        assert.match(err.hints.join(' '), /CR/); // the valid codes are offered
        return true;
    });
});

test('IUCN_STATUS_QIDS and IUCN_QID_TO_CODE are exact inverses', () => {
    for (const [code, qid] of Object.entries(IUCN_STATUS_QIDS)) {
        assert.equal(IUCN_QID_TO_CODE[qid], code);
    }
});

test('compareAncestorTrees: counts rank matches and mismatches by rank', () => {
    const wd = [
        { name: 'Felidae', rankQid: 'Q35409' },  // family
        { name: 'Panthera', rankQid: 'Q34740' }, // genus
    ];
    const inat = [
        { name: 'Felidae', rank: 'family' },
        { name: 'Panthera', rank: 'genus' },
    ];
    const r = compareAncestorTrees(wd, inat);
    assert.equal(r.matches, 2);
    assert.equal(r.mismatches, 0);
    assert.deepEqual(new Set(r.matchedRanks), new Set(['family', 'genus']));
});

test('compareAncestorTrees: name disagreement at a shared rank is a mismatch', () => {
    const wd = [{ name: 'Panthera', rankQid: 'Q34740' }];
    const inat = [{ name: 'Puma', rank: 'genus' }];
    const r = compareAncestorTrees(wd, inat);
    assert.equal(r.matches, 0);
    assert.equal(r.mismatches, 1);
    assert.deepEqual(r.matchedRanks, []);
});

test('compareAncestorTrees: ranks present on only one side are ignored, and it is case-insensitive', () => {
    const wd = [{ name: 'FELIDAE', rankQid: 'Q35409' }, { name: 'Panthera', rankQid: 'Q34740' }];
    const inat = [{ name: 'felidae', rank: 'family' }]; // no genus on the iNat side
    const r = compareAncestorTrees(wd, inat);
    assert.equal(r.matches, 1);
    assert.equal(r.mismatches, 0);
    assert.deepEqual(r.matchedRanks, ['family']);
});

/** Builds one fetchWdAncestorChains binding row (SPARQL JSON-binding shape). */
function ancestorRow(item, directParent, ancestor, name, rankQid, parent) {
    const uri = (qid) => `http://www.wikidata.org/entity/${qid}`;
    return {
        item: { value: uri(item) },
        directParent: { value: uri(directParent) },
        ancestor: { value: uri(ancestor) },
        ancestorName: { value: name },
        ancestorRank: { value: uri(rankQid) },
        ...(parent ? { ancestorParent: { value: uri(parent) } } : {}),
    };
}

test('fetchWdAncestorChains: a duplicate P171 statement does not truncate the chain', async () => {
    // Order (Q30) carries two P171 statements: the true continuation (Q40, "Class", which itself
    // has a name and so appears as its own ancestor row) and a second, dead-end statement (Q999,
    // which never appears as its own ancestor row — e.g. because it lacks P225, so the required
    // ?ancestor wdt:P225 ?ancestorName join drops it from the result set entirely). The old
    // last-row-wins Map used to pick whichever came later in the bindings array; here Q999 does.
    const rows = [
        ancestorRow('Q1', 'Q10', 'Q10', 'Genus', 'Q34740', 'Q20'),
        ancestorRow('Q1', 'Q10', 'Q20', 'Family', 'Q35409', 'Q30'),
        ancestorRow('Q1', 'Q10', 'Q30', 'Order', 'Q36602', 'Q40'),
        ancestorRow('Q1', 'Q10', 'Q30', 'Order', 'Q36602', 'Q999'),
        ancestorRow('Q1', 'Q10', 'Q40', 'Class', 'Q37517', null),
    ];
    const treeMap = await fetchWdAncestorChains([{ qid: 'Q1' }], async () => rows, qidFromUri, chunk);
    assert.deepEqual(treeMap.get('Q1'), [
        { name: 'Class', rankQid: 'Q37517' },
        { name: 'Order', rankQid: 'Q36602' },
        { name: 'Family', rankQid: 'Q35409' },
        { name: 'Genus', rankQid: 'Q34740' },
    ]);
});

test('fetchWdAncestorChains: result does not depend on SPARQL row order', async () => {
    const rows = [
        ancestorRow('Q1', 'Q10', 'Q10', 'Genus', 'Q34740', 'Q20'),
        ancestorRow('Q1', 'Q10', 'Q20', 'Family', 'Q35409', 'Q30'),
        ancestorRow('Q1', 'Q10', 'Q30', 'Order', 'Q36602', 'Q999'), // dead-end row now comes first
        ancestorRow('Q1', 'Q10', 'Q30', 'Order', 'Q36602', 'Q40'),
        ancestorRow('Q1', 'Q10', 'Q40', 'Class', 'Q37517', null),
    ];
    const treeMap = await fetchWdAncestorChains([{ qid: 'Q1' }], async () => rows, qidFromUri, chunk);
    assert.deepEqual(treeMap.get('Q1').map(e => e.name), ['Class', 'Order', 'Family', 'Genus']);
});

test('fetchWdAncestorChains: a plain single-parent chain still works', async () => {
    const rows = [
        ancestorRow('Q1', 'Q10', 'Q10', 'Genus', 'Q34740', 'Q20'),
        ancestorRow('Q1', 'Q10', 'Q20', 'Family', 'Q35409', null),
    ];
    const treeMap = await fetchWdAncestorChains([{ qid: 'Q1' }], async () => rows, qidFromUri, chunk);
    assert.deepEqual(treeMap.get('Q1'), [
        { name: 'Family', rankQid: 'Q35409' },
        { name: 'Genus', rankQid: 'Q34740' },
    ]);
});

test('fetchWdAncestorChains: batches run concurrently, bounded by opts.concurrency', async () => {
    // Two items land in separate 1-item batches (batch size is fixed at 50, so two calls happen
    // only because chunkFn here artificially splits them one per batch).
    let inFlight = 0, maxInFlight = 0;
    const oneItemChunks = (arr) => arr.map(x => [x]);
    const fakeSparql = async (query) => {
        inFlight++;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await new Promise(r => setTimeout(r, 5));
        inFlight--;
        const qid = query.match(/wd:(Q\d+)/)[1];
        return [ancestorRow(qid, 'Q10', 'Q10', 'Genus', 'Q34740', null)];
    };
    const items = [{ qid: 'Q1' }, { qid: 'Q2' }, { qid: 'Q3' }];
    const treeMap = await fetchWdAncestorChains(items, fakeSparql, qidFromUri, oneItemChunks, { concurrency: 2 });
    assert.equal(treeMap.size, 3);
    assert.equal(maxInFlight, 2, 'concurrency should be bounded, not unlimited or serial');
});

test('reqInit identifies us and bounds the request', () => {
    const init = reqInit();
    assert.equal(init.headers, HEADERS, 'every outbound call says who we are');
    assert.ok(init.signal instanceof AbortSignal);
    assert.equal(init.signal.aborted, false);
});

test('reqInit takes custom headers without losing the timeout', () => {
    const init = reqInit(SPARQL_TIMEOUT_MS, { ...HEADERS, Accept: 'text/tab-separated-values' });
    assert.equal(init.headers.Accept, 'text/tab-separated-values');
    assert.equal(init.headers['User-Agent'], HEADERS['User-Agent']);
    assert.ok(init.signal instanceof AbortSignal);
});

test('WDQS gets a longer budget than everything else', () => {
    // Its own query limit is 60s, so a 30s client timeout would abandon queries the service
    // still intends to answer.
    assert.ok(SPARQL_TIMEOUT_MS > 60_000);
    assert.ok(FETCH_TIMEOUT_MS < SPARQL_TIMEOUT_MS);
});

test('a request actually aborts when its budget runs out', async () => {
    const init = reqInit(10);
    await new Promise(r => setTimeout(r, 30));
    assert.equal(init.signal.aborted, true, 'a stalled connection must not hang a run forever');
});

// ---- fetchWithRetry: the shared retry+backoff primitive sparql()/sparqlTSV()/sparqlPost() and
// fetchEntitiesBatched()'s default path all funnel through — one place worth exercising the
// retry-then-log behaviour, since every caller above just supplies a label and forwards its log.

test('fetchWithRetry retries a retryable HTTP status, logging via log.warn each time', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const log = fakeLog();
    let calls = 0;
    const doFetch = async () => {
        calls++;
        return calls === 1 ? fakeResponse(503, false) : fakeResponse(200, true);
    };
    const promise = fetchWithRetry(doFetch, 2, 'Test', log);
    // doFetch's own await must resolve, and fetchWithRetry must reach its setTimeout call,
    // before there is anything for tick() to advance — otherwise tick() fires before the timer
    // exists and the test hangs waiting for a timer that was scheduled too late to be caught.
    await new Promise((r) => setImmediate(r));
    await t.mock.timers.tick(6000); // sparqlRetryDelay(503, 2) === (4 - 2) * 3000
    const res = await promise;
    assert.equal(res.status, 200);
    assert.equal(calls, 2);
    assert.equal(log.calls.warn.length, 1);
    assert.match(log.calls.warn[0][0], /Test HTTP 503, retrying/);
});

test('fetchWithRetry retries a hung connection (TimeoutError), logging via log.warn', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const log = fakeLog();
    let calls = 0;
    const doFetch = async () => {
        calls++;
        if (calls === 1) {
            const err = new Error('the operation was aborted');
            err.name = 'TimeoutError';
            throw err;
        }
        return fakeResponse(200, true);
    };
    const promise = fetchWithRetry(doFetch, 2, 'Test', log);
    await new Promise((r) => setImmediate(r));
    await t.mock.timers.tick(6000); // sparqlRetryDelay(null, 2) === (4 - 2) * 3000
    const res = await promise;
    assert.equal(res.status, 200);
    assert.equal(log.calls.warn.length, 1);
    assert.match(log.calls.warn[0][0], /Test request timed out, retrying/);
});

test('fetchWithRetry gives up once retries are exhausted, throwing without a retry log', async () => {
    const log = fakeLog();
    const doFetch = async () => fakeResponse(503, false);
    await assert.rejects(() => fetchWithRetry(doFetch, 0, 'Test', log), /Test HTTP 503/);
    assert.equal(log.calls.warn.length, 0, 'retries === 0 never enters the retry branch');
});

test('fetchWithRetry defaults log to console, so existing callers are unaffected', async () => {
    const doFetch = async () => fakeResponse(200, true);
    const res = await fetchWithRetry(doFetch, 3);
    assert.equal(res.status, 200);
});
