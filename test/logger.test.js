// @ts-check
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { timed, noopLogger, REDACTED_PATHS } from '../server/logger.js';

const LOGGER_MODULE = fileURLToPath(new URL('../server/logger.js', import.meta.url));

test('timed() logs {label, durationMs} at info and returns the result on success', async () => {
    const calls = { info: [], error: [] };
    const log = { info: (...a) => calls.info.push(a), error: (...a) => calls.error.push(a) };
    const result = await timed(log, 'sparql', async () => 42);
    assert.equal(result, 42);
    assert.equal(calls.error.length, 0);
    assert.equal(calls.info.length, 1);
    const [fields, msg] = calls.info[0];
    assert.equal(fields.label, 'sparql');
    assert.equal(typeof fields.durationMs, 'number');
    assert.equal(msg, 'sparql');
});

test('timed() logs at error with err attached and rethrows on failure', async () => {
    const calls = { info: [], error: [] };
    const log = { info: (...a) => calls.info.push(a), error: (...a) => calls.error.push(a) };
    const boom = new Error('boom');
    await assert.rejects(() => timed(log, 'commons', async () => { throw boom; }), boom);
    assert.equal(calls.info.length, 0);
    assert.equal(calls.error.length, 1);
    const [fields] = calls.error[0];
    assert.equal(fields.label, 'commons');
    assert.equal(fields.err, boom);
});

test('noopLogger has no filesystem side effects and every level is callable', () => {
    for (const level of ['trace', 'debug', 'info', 'warn', 'error', 'fatal']) {
        assert.doesNotThrow(() => noopLogger[level]('anything'));
    }
    assert.equal(noopLogger.child(), noopLogger);
});

test('REDACTED_PATHS covers cookie, authorization and set-cookie', () => {
    assert.deepEqual(REDACTED_PATHS, [
        'req.headers.cookie',
        'req.headers.authorization',
        'res.headers["set-cookie"]',
    ]);
});

test('createLogger() writes NDJSON to both stdout and a rotated file under logsDir', () => {
    const logsDir = mkdtempSync(path.join(tmpdir(), 'winc-logger-test-'));
    try {
        const script = `
            import { createLogger } from ${JSON.stringify(LOGGER_MODULE)};
            const log = createLogger({ logsDir: ${JSON.stringify(logsDir)}, level: 'info' });
            log.info({ marker: 'winc-logger-test' }, 'hello');
            log.flush(() => process.exit(0));
        `;
        const stdout = execFileSync(process.execPath, ['--input-type=module'], {
            input: script, encoding: 'utf8', timeout: 10_000,
        });

        const stdoutLine = stdout.trim().split('\n').find(l => l.includes('winc-logger-test'));
        assert.ok(stdoutLine, `expected a log line on stdout, got: ${stdout}`);
        const stdoutParsed = JSON.parse(stdoutLine);
        assert.equal(stdoutParsed.msg, 'hello');
        assert.equal(stdoutParsed.marker, 'winc-logger-test');

        const files = readdirSync(logsDir).filter(f => /^app\.\d{4}-\d{2}-\d{2}\.\d+\.log$/.test(f));
        assert.equal(files.length, 1, `expected one rotated file, found: ${readdirSync(logsDir)}`);
        const fileContent = readFileSync(path.join(logsDir, files[0]), 'utf8').trim();
        const fileParsed = JSON.parse(fileContent.split('\n')[0]);
        assert.equal(fileParsed.msg, 'hello');
        assert.equal(fileParsed.marker, 'winc-logger-test');
    } finally {
        rmSync(logsDir, { recursive: true, force: true });
    }
});
