// @ts-check
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseTime, resolveRange } from '../time.js';

const NOW = Date.parse('2026-08-28T12:00:00.000Z');

test('parseTime: epoch milliseconds pass through unchanged', () => {
    assert.equal(parseTime(12345, NOW), 12345);
});

test('parseTime: relative ages are "that long before now"', () => {
    assert.equal(parseTime('90m', NOW), NOW - 90 * 60 * 1000);
    assert.equal(parseTime('24h', NOW), NOW - 24 * 60 * 60 * 1000);
    assert.equal(parseTime('7d', NOW), NOW - 7 * 24 * 60 * 60 * 1000);
});

test('parseTime: relative ages are case-insensitive', () => {
    assert.equal(parseTime('24H', NOW), NOW - 24 * 60 * 60 * 1000);
});

test('parseTime: an ISO timestamp parses to its own epoch value', () => {
    assert.equal(parseTime('2026-08-27T10:00:00.000Z', NOW), Date.parse('2026-08-27T10:00:00.000Z'));
});

test('parseTime: an unrecognised string throws, not NaN', () => {
    assert.throws(() => parseTime('yesterday', NOW), /Unrecognised time/);
});

test('resolveRange: defaults to the last 24 hours', () => {
    const range = resolveRange({}, NOW);
    assert.equal(range.since, NOW - 24 * 60 * 60 * 1000);
    assert.equal(range.until, NOW);
});

test('resolveRange: an explicit since/until pair is used as given', () => {
    const range = resolveRange({ since: '7d', until: '90m' }, NOW);
    assert.equal(range.since, NOW - 7 * 24 * 60 * 60 * 1000);
    assert.equal(range.until, NOW - 90 * 60 * 1000);
});

test('resolveRange: until before since is rejected rather than silently empty', () => {
    assert.throws(() => resolveRange({ since: '1h', until: '2h' }, NOW), /Empty time range/);
});
