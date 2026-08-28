// @ts-check
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { listLogFiles, selectLogFiles } from '../logFiles.js';

const FIXTURES = fileURLToPath(new URL('./fixtures/', import.meta.url));

test('listLogFiles: dated files come back oldest first', async () => {
    const files = await listLogFiles(FIXTURES);
    assert.deepEqual(files.map(f => f.name), ['app.2026-08-27.1.log', 'app.2026-08-28.1.log']);
    assert.equal(files[0].date, '2026-08-27');
    assert.equal(files[1].date, '2026-08-28');
});

test('listLogFiles: current.log (a symlink) is excluded even though its target matches', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'winc-mcp-logfiles-'));
    try {
        writeFileSync(path.join(dir, 'app.2026-08-28.1.log'), '{"level":30,"time":1,"msg":"x"}\n');
        symlinkSync(path.join(dir, 'app.2026-08-28.1.log'), path.join(dir, 'current.log'));
        const files = await listLogFiles(dir);
        assert.deepEqual(files.map(f => f.name), ['app.2026-08-28.1.log']);
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

test('listLogFiles: a legacy undated file (app.<n>.log) is picked up with date: null', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'winc-mcp-logfiles-'));
    try {
        writeFileSync(path.join(dir, 'app.3.log'), '{"level":30,"time":1,"msg":"x"}\n');
        const files = await listLogFiles(dir);
        assert.equal(files.length, 1);
        assert.equal(files[0].date, null);
        assert.equal(files[0].index, 3);
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

test('listLogFiles: anything not matching either naming pattern is ignored', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'winc-mcp-logfiles-'));
    try {
        writeFileSync(path.join(dir, 'notes.txt'), 'irrelevant');
        writeFileSync(path.join(dir, 'app.2026-08-28.1.log'), '{"level":30,"time":1,"msg":"x"}\n');
        const files = await listLogFiles(dir);
        assert.deepEqual(files.map(f => f.name), ['app.2026-08-28.1.log']);
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

const DAY_MS = 24 * 60 * 60 * 1000;
const day27 = Date.parse('2026-08-27T00:00:00Z');
const day28 = Date.parse('2026-08-28T00:00:00Z');
/** @type {(overrides: Partial<import('../types.js').LogFile>) => import('../types.js').LogFile} */
const file = (overrides) => ({ name: 'x', path: '/x', date: null, index: 0, sizeBytes: 0, mtimeMs: 0, ...overrides });

test('selectLogFiles: a dated file whose whole (widened) day is outside the window is dropped', () => {
    const files = [file({ name: 'old', date: '2026-08-27', mtimeMs: day27 })];
    // A window starting well after 2026-08-27's widened end (day27 + 2*DAY_MS) excludes it.
    const kept = selectLogFiles(files, { since: day27 + 3 * DAY_MS, until: day27 + 4 * DAY_MS });
    assert.deepEqual(kept, []);
});

test('selectLogFiles: the day-window check alone excludes an old date even with a fresh mtime', () => {
    // mtimeMs set just inside `since - DAY_MS` so the mtime check alone would not exclude it —
    // isolating the date-window (dayEnd + DAY_MS < since) branch as what actually does.
    const since = day27 + 2 * DAY_MS + 5000;
    const files = [file({ name: 'old', date: '2026-08-27', mtimeMs: since - DAY_MS })];
    assert.deepEqual(selectLogFiles(files, { since }), []);
});

test('selectLogFiles: the widened day window keeps a file just across midnight from the range', () => {
    // `since` one hour into 2026-08-28 — a naive (unwidened) check might drop 08-27, but the
    // writer's local midnight can disagree with the reader's UTC one, so the window is widened.
    const since = day28 + 60 * 60 * 1000;
    const files = [file({ name: 'yesterday', date: '2026-08-27', mtimeMs: day28 })];
    assert.deepEqual(selectLogFiles(files, { since }).map(f => f.name), ['yesterday']);
});

test('selectLogFiles: a dated file inside the window is kept', () => {
    const files = [file({ name: 'today', date: '2026-08-28', mtimeMs: day28 })];
    const kept = selectLogFiles(files, { since: day28, until: day28 + 1000 });
    assert.deepEqual(kept.map(f => f.name), ['today']);
});

test('selectLogFiles: an undated (legacy) file is pruned only by mtime, never by name', () => {
    const stale = file({ name: 'legacy-stale', date: null, mtimeMs: day27 });
    const fresh = file({ name: 'legacy-fresh', date: null, mtimeMs: day28 });
    // since - DAY_MS must clear the stale file's mtime (day27) but not the fresh one's (day28).
    const kept = selectLogFiles([stale, fresh], { since: day28 + 1000 });
    assert.deepEqual(kept.map(f => f.name), ['legacy-fresh']);
});

test('selectLogFiles: no range at all keeps everything', () => {
    const files = [file({ name: 'a', date: '2026-08-27' }), file({ name: 'b', date: null })];
    assert.deepEqual(selectLogFiles(files).map(f => f.name), ['a', 'b']);
});
