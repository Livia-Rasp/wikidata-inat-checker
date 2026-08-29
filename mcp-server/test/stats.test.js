// @ts-check
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LatencyAccumulator, normaliseRoute, percentile } from '../stats.js';

test('normaliseRoute: collapses a finding id out of the parameterised action routes', () => {
    assert.equal(normaliseRoute('/api/findings/42/confirm'), '/api/findings/:id/confirm');
    assert.equal(normaliseRoute('/api/findings/7/skip'), '/api/findings/:id/skip');
    assert.equal(normaliseRoute('/api/findings/7/unskip'), '/api/findings/:id/unskip');
    assert.equal(normaliseRoute('/api/findings/7/pick'), '/api/findings/:id/pick');
});

test('normaliseRoute: strips the query string and a trailing slash, otherwise passes through', () => {
    assert.equal(normaliseRoute('/api/findings?limit=2'), '/api/findings');
    assert.equal(normaliseRoute('/api/findings/'), '/api/findings');
    assert.equal(normaliseRoute('/discover/area'), '/discover/area');
});

test('normaliseRoute: the bulk confirm route (no id in the path) is unaffected', () => {
    assert.equal(normaliseRoute('/api/findings/confirm'), '/api/findings/confirm');
});

test('percentile: nearest-rank, never an interpolated value no sample had', () => {
    const sorted = [10, 20, 30, 40, 50];
    assert.equal(percentile(sorted, 50), 30);
    assert.equal(percentile(sorted, 95), 50);
    assert.equal(percentile(sorted, 100), 50);
    assert.ok(sorted.includes(percentile(sorted, 37)));
});

test('percentile: an empty array is 0, not NaN or a thrown error', () => {
    assert.equal(percentile([], 50), 0);
});

/** @type {(overrides: Partial<import('../types.js').LogLine>) => import('../types.js').LogLine} */
const line = (overrides) => ({ level: 30, time: 0, ...overrides });

test('LatencyAccumulator: groupBy "route" reads responseTime off completion lines, grouped by route', () => {
    const acc = new LatencyAccumulator({ groupBy: 'route' });
    acc.add(line({ req: { url: '/api/findings/1/confirm' }, responseTime: 100 }));
    acc.add(line({ req: { url: '/api/findings/2/confirm' }, responseTime: 300 }));
    acc.add(line({ req: { url: '/api/findings' }, responseTime: 10 }));
    const groups = acc.finish();
    const byGroup = Object.fromEntries(groups.map(g => [g.group, g]));
    assert.equal(byGroup['/api/findings/:id/confirm'].count, 2);
    assert.equal(byGroup['/api/findings/:id/confirm'].min, 100);
    assert.equal(byGroup['/api/findings/:id/confirm'].max, 300);
    assert.equal(byGroup['/api/findings'].count, 1);
});

test('LatencyAccumulator: groupBy "route" ignores lines with no responseTime or no url', () => {
    const acc = new LatencyAccumulator({ groupBy: 'route' });
    acc.add(line({ req: { url: '/api/findings' } })); // no responseTime — not a completion line
    acc.add(line({ responseTime: 5 })); // no url
    assert.deepEqual(acc.finish(), []);
});

test('LatencyAccumulator: groupBy "step" reads durationMs/label off timed() lines', () => {
    const acc = new LatencyAccumulator({ groupBy: 'step' });
    acc.add(line({ label: 'confirmByKind', durationMs: 850 }));
    acc.add(line({ label: 'confirmByKind', durationMs: 950 }));
    acc.add(line({ label: 'fetchAreaCandidates', durationMs: 1300 }));
    const groups = acc.finish();
    const byGroup = Object.fromEntries(groups.map(g => [g.group, g]));
    assert.equal(byGroup.confirmByKind.count, 2);
    assert.equal(byGroup.confirmByKind.mean, 900);
    assert.equal(byGroup.fetchAreaCandidates.count, 1);
});

test('LatencyAccumulator: finish() sorts slowest p95 first', () => {
    const acc = new LatencyAccumulator({ groupBy: 'step' });
    acc.add(line({ label: 'fast', durationMs: 10 }));
    acc.add(line({ label: 'slow', durationMs: 1000 }));
    const groups = acc.finish();
    assert.deepEqual(groups.map(g => g.group), ['slow', 'fast']);
});

test('LatencyAccumulator: no samples produces an empty summary, not an error', () => {
    assert.deepEqual(new LatencyAccumulator({ groupBy: 'route' }).finish(), []);
});
