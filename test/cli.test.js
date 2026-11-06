// @ts-check
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { interruptibleRun } from '../lib/cli.js';
import { makeStore } from './helpers.js';

/** A stand-in for `process`: signals are emitted by hand, and exit() is recorded, not obeyed. */
function fakeProc() {
    const proc = Object.assign(new EventEmitter(), { exits: /** @type {number[]} */ ([]) });
    return Object.assign(proc, { exit: (/** @type {number} */ code) => { proc.exits.push(code); } });
}

const quiet = { error: () => {} };

test('the first Ctrl-C asks the run to stop and leaves recording it to the pipeline', () => {
    const { store } = makeStore();
    const proc = fakeProc();
    const stop = interruptibleRun(store, { proc, log: quiet });
    const runId = store.startRun('images', {});
    stop.track(() => {})({ runId, phase: 'querying' });

    proc.emit('SIGINT', 'SIGINT');
    assert.equal(stop.signal.aborted, true);
    assert.equal(stop.stopped, true);
    assert.deepEqual(proc.exits, [], 'no exit yet: the pipeline still has to write `cancelled`');
    assert.equal(store.latestRun('images').state, 'running');
});

test('a second Ctrl-C marks the run interrupted and exits at once', () => {
    const { store } = makeStore();
    const proc = fakeProc();
    const stop = interruptibleRun(store, { proc, log: quiet });
    const runId = store.startRun('images', {});
    stop.track(() => {})({ runId });

    proc.emit('SIGINT', 'SIGINT');
    proc.emit('SIGINT', 'SIGINT');
    assert.equal(store.latestRun('images').state, 'interrupted');
    assert.deepEqual(proc.exits, [130]);
});

test('SIGTERM stops the same way and exits with its own code', () => {
    const { store } = makeStore();
    const proc = fakeProc();
    const stop = interruptibleRun(store, { proc, log: quiet });
    stop.setRunId(store.startRun('images', {}));
    proc.emit('SIGTERM', 'SIGTERM');
    proc.emit('SIGTERM', 'SIGTERM');
    assert.deepEqual(proc.exits, [143]);
});

test('a signal before the run row exists has nothing to mark, so it just exits', () => {
    const { store } = makeStore();
    const proc = fakeProc();
    interruptibleRun(store, { proc, log: quiet });
    proc.emit('SIGINT', 'SIGINT');
    assert.deepEqual(proc.exits, [130]);
    assert.equal(store.latestRun(), null);
});

test('without graceful, the first signal interrupts', () => {
    const { store } = makeStore();
    const proc = fakeProc();
    const stop = interruptibleRun(store, { proc, log: quiet, graceful: false });
    stop.setRunId(store.startRun('verify', {}));
    proc.emit('SIGINT', 'SIGINT');
    assert.equal(store.latestRun('verify').state, 'interrupted');
    assert.deepEqual(proc.exits, [130]);
});

test('track passes every report through unchanged', () => {
    const { store } = makeStore();
    const proc = fakeProc();
    const seen = [];
    const report = interruptibleRun(store, { proc, log: quiet }).track((p) => seen.push(p));
    report({ runId: 7, phase: 'querying' });
    report({ phase: 'checking' });
    assert.deepEqual(seen, [{ runId: 7, phase: 'querying' }, { phase: 'checking' }]);
});

test('dispose hands the signals back', () => {
    const { store } = makeStore();
    const proc = fakeProc();
    const stop = interruptibleRun(store, { proc, log: quiet });
    assert.equal(proc.listenerCount('SIGINT'), 1);
    assert.equal(proc.listenerCount('SIGTERM'), 1);
    stop.dispose();
    assert.equal(proc.listenerCount('SIGINT'), 0);
    assert.equal(proc.listenerCount('SIGTERM'), 0);
});
