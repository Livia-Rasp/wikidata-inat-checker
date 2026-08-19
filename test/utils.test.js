// @ts-check
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    chunk, qidFromUri, escapeHtml, compareAncestorTrees,
    parseArgs, parseLimit, parseIucnArg,
    IUCN_STATUS_QIDS, IUCN_QID_TO_CODE,
    reqInit, HEADERS, FETCH_TIMEOUT_MS, SPARQL_TIMEOUT_MS,
} from '../lib/utils.js';
import { UsageError } from '../lib/cli.js';

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
