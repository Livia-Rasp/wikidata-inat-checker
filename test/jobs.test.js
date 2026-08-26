// @ts-check
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createJobs } from '../server/jobs.js';

/**
 * Stands in for a forked child: every lifecycle path can be driven without a real process.
 * @returns {EventEmitter & {sent: any[], signals: any[], send: (m: any) => void, kill: (sig: any) => boolean, stderr: EventEmitter}}
 */
function fakeChild() {
    const child = /** @type {any} */ (new EventEmitter());
    child.sent = [];
    child.signals = [];
    child.send = (m) => child.sent.push(m);
    child.kill = (sig) => { child.signals.push(sig); return true; };
    child.stderr = new EventEmitter();
    return child;
}

function makeJobs(overrides = {}) {
    const child = fakeChild();
    const jobs = createJobs({ spawn: () => child, ...overrides });
    return { jobs, child };
}

const CONFIG = { scope: { iucn: 'VU' }, limit: 10, dbFile: ':memory:' };

test('a run starts, and the config reaches the child', () => {
    const { jobs, child } = makeJobs();
    const started = jobs.start(CONFIG);

    assert.equal(started.state, 'running');
    assert.deepEqual(child.sent, [{ type: 'start', config: CONFIG }]);
    assert.deepEqual(jobs.status().scope, { iucn: 'VU' });
});

test('only one run at a time', () => {
    const { jobs } = makeJobs();
    assert.ok(jobs.start(CONFIG));
    // Two simultaneous POSTs must not both fork; the claim is synchronous for exactly this reason.
    assert.equal(jobs.start(CONFIG), null);
    assert.equal(jobs.status().state, 'running');
});

test('progress updates the record, and the run id is remembered', () => {
    const { jobs, child } = makeJobs();
    jobs.start(CONFIG);

    child.emit('message', { type: 'progress', phase: 'checking', runId: 7, counts: { taxa: 500 } });
    const s = jobs.status();
    assert.equal(s.phase, 'checking');
    assert.equal(s.runId, 7);
    assert.deepEqual(s.counts, { taxa: 500 });
});

test('a finished run reports what it found', () => {
    const { jobs, child } = makeJobs();
    jobs.start(CONFIG);
    child.emit('message', { type: 'done', result: { runId: 7, open: 3, scanned: 10 } });

    const s = jobs.status();
    assert.equal(s.state, 'done');
    assert.equal(s.counts.open, 3);
    assert.ok(s.finishedAt);
    assert.ok(jobs.start(CONFIG), 'and the slot is free again');
});

test('a run that cancelled itself says so rather than claiming success', () => {
    const { jobs, child } = makeJobs();
    jobs.start(CONFIG);
    child.emit('message', { type: 'done', result: { runId: 7, open: 1, cancelled: true } });
    assert.equal(jobs.status().state, 'cancelled');
});

test('an error from the child is kept as its code and message', () => {
    const { jobs, child } = makeJobs();
    jobs.start(CONFIG);
    child.emit('message', { type: 'error', code: 'unknown_taxon', message: 'Taxon "X" is not in the index.' });

    const s = jobs.status();
    assert.equal(s.state, 'error');
    assert.deepEqual(s.error, { code: 'unknown_taxon', message: 'Taxon "X" is not in the index.' });
});

test('a child that dies before saying anything is an error, not a silent idle', () => {
    const { jobs, child } = makeJobs();
    jobs.start(CONFIG);
    child.emit('exit', 1, null);

    assert.equal(jobs.status().state, 'error');
    assert.equal(jobs.status().error.code, 'died');
    assert.match(jobs.status().error.message, /exited with code 1/);
});

test('an exit of 0 without a result is still a failure', () => {
    const { jobs, child } = makeJobs();
    jobs.start(CONFIG);
    // The child said nothing. Treating this as success would report a run that never happened.
    child.emit('exit', 0, null);
    assert.equal(jobs.status().state, 'error');
});

test('a SIGKILL is never reported as a cancel', () => {
    const { jobs, child } = makeJobs();
    jobs.start(CONFIG);
    // The OOM killer sends the same signal a cancel does, and a 650MB child is a plausible target.
    child.emit('exit', null, 'SIGKILL');
    assert.equal(jobs.status().state, 'error');
    assert.match(jobs.status().error.message, /SIGKILL/);
});

test('fork failing at all is reported', () => {
    const { jobs, child } = makeJobs();
    jobs.start(CONFIG);
    child.emit('error', new Error('spawn EAGAIN'));
    assert.equal(jobs.status().error.code, 'spawn_failed');
});

test('cancelling signals the child, politely first', () => {
    const { jobs, child } = makeJobs();
    jobs.start(CONFIG);
    assert.deepEqual(jobs.cancel(), { cancelled: true });
    assert.deepEqual(child.signals, ['SIGTERM']);

    child.emit('exit', null, 'SIGTERM');
    assert.equal(jobs.status().state, 'cancelled');
});

test('a stale run id cannot cancel a later run', () => {
    const { jobs, child } = makeJobs();
    jobs.start(CONFIG);
    child.emit('message', { type: 'progress', phase: 'checking', runId: 9 });

    assert.deepEqual(jobs.cancel(3), { cancelled: false, reason: 'stale_run_id' });
    assert.deepEqual(child.signals, [], 'and it did not touch the child');
    assert.deepEqual(jobs.cancel(9), { cancelled: true });
});

test('cancelling nothing is not an error', () => {
    const { jobs } = makeJobs();
    assert.deepEqual(jobs.cancel(), { cancelled: false, reason: 'not_running' });
});

test('a run with no progress is stopped by the watchdog', async () => {
    const { jobs, child } = makeJobs({ watchdogMs: 10 });
    jobs.start(CONFIG);
    await new Promise(r => setTimeout(r, 40));

    // Node's fetch has no default timeout, so "wedged but alive" is a real state, not a theory.
    assert.deepEqual(child.signals, ['SIGTERM']);
    assert.equal(jobs.status().error.code, 'timeout');
});

test('progress keeps the watchdog at bay', async () => {
    const { jobs, child } = makeJobs({ watchdogMs: 60 });
    jobs.start(CONFIG);
    for (let i = 0; i < 3; i++) {
        await new Promise(r => setTimeout(r, 25));
        child.emit('message', { type: 'progress', phase: 'checking', counts: { batch: i } });
    }
    assert.deepEqual(child.signals, [], 'a long but living run is left alone');
    assert.equal(jobs.status().state, 'running');
});

test('closing kills the child and waits for it', async () => {
    const { jobs, child } = makeJobs();
    jobs.start(CONFIG);

    const closing = jobs.close();
    assert.deepEqual(child.signals, ['SIGTERM']);
    child.emit('exit', null, 'SIGTERM');
    await closing;   // the server must not exit leaving a child holding the database
    assert.equal(jobs.status().state, 'cancelled');
});

test('closing with nothing running returns immediately', async () => {
    const { jobs } = makeJobs();
    await jobs.close();
});
