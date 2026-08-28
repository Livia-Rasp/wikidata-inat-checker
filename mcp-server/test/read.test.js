// @ts-check
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { listLogFiles } from '../logFiles.js';
import { emptyStats, matches, projectLine, readLogLines, streamLogLines } from '../read.js';

const FIXTURES = fileURLToPath(new URL('./fixtures/', import.meta.url));

/** @type {(overrides: Partial<import('../types.js').LogLine>) => import('../types.js').LogLine} */
const line = (overrides) => ({ level: 30, time: 1000, ...overrides });

// ---- matches() ----

test('matches: since/until bound on line.time', () => {
    const l = line({ time: 500 });
    assert.equal(matches(l, '', { since: 100, until: 900 }), true);
    assert.equal(matches(l, '', { since: 600 }), false);
    assert.equal(matches(l, '', { until: 400 }), false);
});

test('matches: minLevel excludes anything below it', () => {
    assert.equal(matches(line({ level: 40 }), '', { minLevel: 50 }), false);
    assert.equal(matches(line({ level: 50 }), '', { minLevel: 50 }), true);
});

test('matches: requestId is an exact match against the top-level reqId', () => {
    assert.equal(matches(line({ reqId: 'req-a' }), '', { requestId: 'req-a' }), true);
    assert.equal(matches(line({ reqId: 'req-a' }), '', { requestId: 'req-b' }), false);
    assert.equal(matches(line({}), '', { requestId: 'req-a' }), false);
});

test('matches: url is a case-insensitive substring of req.url', () => {
    const l = line({ req: { url: '/api/Findings/1/confirm' } });
    assert.equal(matches(l, '', { url: 'findings' }), true);
    assert.equal(matches(l, '', { url: 'nope' }), false);
    assert.equal(matches(line({}), '', { url: 'findings' }), false, 'no req.url at all');
});

test('matches: minResponseTime requires a numeric responseTime at or above it', () => {
    assert.equal(matches(line({ responseTime: 100 }), '', { minResponseTime: 50 }), true);
    assert.equal(matches(line({ responseTime: 10 }), '', { minResponseTime: 50 }), false);
    assert.equal(matches(line({}), '', { minResponseTime: 50 }), false, 'not a completion line');
});

test('matches: minStatus reads res.statusCode', () => {
    assert.equal(matches(line({ res: { statusCode: 500 } }), '', { minStatus: 400 }), true);
    assert.equal(matches(line({ res: { statusCode: 200 } }), '', { minStatus: 400 }), false);
});

test('matches: errors "server" is an OR of level>=50 and status>=500', () => {
    const filter = { errors: /** @type {const} */ ('server') };
    assert.equal(matches(line({ level: 50 }), '', filter), true, 'an error line with no status at all');
    assert.equal(matches(line({ res: { statusCode: 503 } }), '', filter), true, 'a failing status with no error line');
    assert.equal(matches(line({ res: { statusCode: 429 } }), '', filter), false, '4xx does not count as "server"');
    assert.equal(matches(line({ res: { statusCode: 200 } }), '', filter), false);
});

test('matches: errors "any" also counts 4xx', () => {
    assert.equal(matches(line({ res: { statusCode: 429 } }), '', { errors: 'any' }), true);
    assert.equal(matches(line({ res: { statusCode: 200 } }), '', { errors: 'any' }), false);
});

test('matches: contains is a case-insensitive substring of the raw line', () => {
    assert.equal(matches(line({}), 'SPARQL HTTP 503, retrying', { contains: 'sparql' }), true);
    assert.equal(matches(line({}), 'all fine', { contains: 'sparql' }), false);
});

// ---- projectLine() ----

test('projectLine: surfaces requestId/method/url/status from req/res, drops the raw objects', () => {
    const projected = projectLine(line({
        reqId: 'req-a',
        req: { method: 'GET', url: '/api/findings', remoteAddress: '127.0.0.1' },
        res: { statusCode: 200 },
        msg: 'request completed',
    }));
    assert.equal(projected.requestId, 'req-a');
    assert.equal(projected.method, 'GET');
    assert.equal(projected.url, '/api/findings');
    assert.equal(projected.remoteAddress, '127.0.0.1');
    assert.equal(projected.status, 200);
    assert.equal(projected.msg, 'request completed');
    assert.equal('req' in projected, false, 'the raw req object must not survive');
    assert.equal('res' in projected, false, 'the raw res object must not survive');
});

test('projectLine: level is named, not the raw pino number', () => {
    assert.equal(projectLine(line({ level: 50 })).level, 'error');
    assert.equal(projectLine(line({ level: 999 })).level, '999', 'an unrecognised level falls back to its string form');
});

test('projectLine: an unhandled key (business context) survives untouched', () => {
    const projected = projectLine(line({ label: 'confirmByKind', durationMs: 850 }));
    assert.equal(projected.label, 'confirmByKind');
    assert.equal(projected.durationMs, 850);
});

test('projectLine: err is reduced to type/message, and the stack only with { stack: true }', () => {
    const err = { type: 'Error', message: 'boom', stack: 'Error: boom\n    at x\n    at y' };
    const withoutStack = projectLine(line({ err }));
    assert.deepEqual(withoutStack.err, { type: 'Error', message: 'boom' });
    const withStack = projectLine(line({ err }), { stack: true });
    assert.match(/** @type {any} */ (withStack.err).stack, /Error: boom/);
});

test('projectLine: a long stack is truncated to the first frames plus a count', () => {
    const stack = Array.from({ length: 20 }, (_, i) => `    at frame${i}`).join('\n');
    const projected = projectLine(line({ err: { type: 'Error', message: 'x', stack } }), { stack: true });
    const text = /** @type {any} */ (projected.err).stack;
    assert.match(text, /\.\.\. 12 more frames/);
    assert.ok(text.split('\n').length < 20);
});

// ---- streamLogLines() / readLogLines() against the fixtures ----

test('streamLogLines: reads both fixture files in order and counts scanned/matched', async () => {
    const files = await listLogFiles(FIXTURES);
    const stats = emptyStats();
    const seen = [];
    for await (const l of streamLogLines(files, {}, stats)) seen.push(l.reqId ?? '(no reqId)');
    assert.equal(stats.filesRead, 2);
    assert.equal(stats.linesScanned, seen.length);
    assert.equal(stats.linesMatched, seen.length);
    assert.equal(stats.malformed, 0);
    // Oldest file's lines before the newer file's — chronological, not by insertion order.
    assert.equal(seen[0], '(no reqId)'); // the startup line in app.2026-08-27.1.log
    assert.ok(seen.indexOf('req-old-1') < seen.indexOf('req-a'));
});

test('streamLogLines: a malformed line is counted, not thrown, and reading continues', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'winc-mcp-read-'));
    try {
        writeFileSync(path.join(dir, 'app.2026-08-28.1.log'),
            '{"level":30,"time":1,"msg":"ok-1"}\nnot json at all\n{"level":30,"time":2,"msg":"ok-2"}\n');
        const files = await listLogFiles(dir);
        const stats = emptyStats();
        const seen = [];
        for await (const l of streamLogLines(files, {}, stats)) seen.push(l.msg);
        assert.deepEqual(seen, ['ok-1', 'ok-2']);
        assert.equal(stats.malformed, 1);
        assert.equal(stats.linesScanned, 3);
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

test('readLogLines: order "newest" keeps the most recent matches within limit, still chronological', async () => {
    const files = await listLogFiles(FIXTURES);
    const { lines, stats } = await readLogLines(files, {}, { limit: 3, order: 'newest' });
    assert.equal(lines.length, 3);
    assert.ok(lines[0].time <= lines[1].time && lines[1].time <= lines[2].time, 'chronological order');
    assert.equal(stats.truncated, true, 'far fewer than the full 24 lines were kept');
});

test('readLogLines: order "oldest" keeps the first matches within limit', async () => {
    const files = await listLogFiles(FIXTURES);
    const { lines } = await readLogLines(files, {}, { limit: 1, order: 'oldest' });
    assert.equal(lines.length, 1);
    assert.equal(lines[0].reqId, undefined, 'the very first line in the fixtures is the startup line');
});

test('readLogLines: requestId filter returns exactly one request\'s lines, oldest first', async () => {
    const files = await listLogFiles(FIXTURES);
    const { lines, stats } = await readLogLines(files, { requestId: 'req-b' }, { limit: 10, order: 'oldest' });
    assert.equal(lines.length, 4); // incoming, warn, timed step, completed
    assert.ok(lines.every(l => l.reqId === 'req-b'));
    assert.equal(stats.truncated, false);
});

test('readLogLines: errors "server" surfaces req-c\'s warn (no error line, just a 503) and req-f\'s error line', async () => {
    const files = await listLogFiles(FIXTURES);
    const { lines } = await readLogLines(files, { errors: 'server' }, { limit: 10, order: 'oldest' });
    const ids = new Set(lines.map(l => l.reqId));
    assert.ok(ids.has('req-f'), 'the level-50 "request failed" line');
    assert.ok(lines.some(l => l.reqId === 'req-c' && l.res?.statusCode === 503));
    assert.ok(!ids.has('req-g'), 'req-g is only ever a 429 — "server" must not count it');
});

test('readLogLines: errors "any" also surfaces req-g\'s 429', async () => {
    const files = await listLogFiles(FIXTURES);
    const { lines } = await readLogLines(files, { errors: 'any' }, { limit: 10, order: 'oldest' });
    assert.ok(lines.some(l => l.reqId === 'req-g'));
});

test('readLogLines: minResponseTime isolates the slow /discover/area request', async () => {
    const files = await listLogFiles(FIXTURES);
    const { lines } = await readLogLines(files, { minResponseTime: 1000 }, { limit: 10, order: 'oldest' });
    assert.equal(lines.length, 1);
    assert.equal(lines[0].reqId, 'req-d');
    assert.equal(lines[0].responseTime, 1520.7);
});
