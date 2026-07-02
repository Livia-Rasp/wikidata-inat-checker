// @ts-check
import { test } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { createTaxaAccessor } from '../lib/getInatTaxaDb.js';

// Build an in-memory taxa index from fixture rows, matching the real schema.
// Each row: [taxon_id, name, rank, ancestry] (ancestry = '/'-joined ancestor ids, no self).
function makeAccessor(rows) {
    const db = new Database(':memory:');
    db.exec('CREATE TABLE taxa (taxon_id TEXT PRIMARY KEY, name TEXT NOT NULL, rank TEXT NOT NULL, ancestry TEXT);');
    const ins = db.prepare('INSERT INTO taxa VALUES (?, ?, ?, ?)');
    for (const [id, name, rank, ancestry] of rows) ins.run(id, name, rank, ancestry ?? null);
    return createTaxaAccessor(db);
}

// Fixture modelled on the Panthera bug: species are DIRECT children of the genus, so their
// ancestry *ends* in the genus id (no trailing slash) — the case the old two-LIKE query missed.
const ROWS = [
    ['48460', 'Life', 'stateofmatter', null],
    ['1', 'Animalia', 'kingdom', '48460'],
    ['2', 'Felidae', 'family', '48460/1'],
    ['41962', 'Panthera', 'genus', '48460/1/2'],           // ancestry does NOT contain 41962
    ['41970', 'Panthera onca', 'species', '48460/1/2/41962'],   // direct child: ends in /41962
    ['42048', 'Panthera leo', 'species', '48460/1/2/41962'],    // direct child: ends in /41962
    ['99001', 'Panthera onca onca', 'subspecies', '48460/1/2/41962/41970'], // 41962 in the middle
    ['70000', 'Puma concolor', 'species', '48460/1/2/70001'],   // unrelated (different genus)
];

test('descendantInatIds includes direct-child species (the regression case)', () => {
    const db = makeAccessor(ROWS);
    const got = new Set(db.descendantInatIds('41962'));
    // both direct-child species + the deeper subspecies, but not the genus itself or unrelated taxa
    assert.ok(got.has('41970'), 'Panthera onca (direct child) must be in scope');
    assert.ok(got.has('42048'), 'Panthera leo (direct child) must be in scope');
    assert.ok(got.has('99001'), 'subspecies (ancestor in the middle) must be in scope');
    assert.ok(!got.has('41962'), 'the genus itself is not its own descendant');
    assert.ok(!got.has('70000'), 'unrelated taxa must not be in scope');
    assert.equal(got.size, 3);
});

test('descendantInatIds matches an id at the start and as the whole ancestry string', () => {
    const db = makeAccessor([
        ['500', 'Root taxon', 'order', null],
        ['501', 'Start child', 'family', '500'],            // whole-string case: ancestry === '500'
        ['502', 'Start descendant', 'genus', '500/999'],    // start case: '500/...'
        ['503', 'Elsewhere', 'genus', '999/500'],           // end case: '.../500'
        ['504', 'Unrelated', 'genus', '5000/1'],            // '5000' must NOT match '500'
    ]);
    const got = new Set(db.descendantInatIds('500'));
    assert.deepEqual(got, new Set(['501', '502', '503']));
    assert.ok(!got.has('504'), 'a longer id sharing a prefix must not match');
});

test('getAncestors returns named ancestors root-to-parent, dropping the stateofmatter root', () => {
    const db = makeAccessor(ROWS);
    assert.deepEqual(db.getAncestors('41970'), [
        { name: 'Animalia', rank: 'kingdom' },
        { name: 'Felidae', rank: 'family' },
        { name: 'Panthera', rank: 'genus' },
    ]);
    assert.deepEqual(db.getAncestors('999999'), []); // unknown id → no ancestry
});

test('get returns a lone match, undefined for a homonym or a miss', () => {
    const db = makeAccessor([
        ['10', 'Iris', 'genus', null],       // plant genus
        ['11', 'Iris', 'genus', null],       // homonym (insect genus) — same name
        ['12', 'Unique', 'species', null],
    ]);
    assert.equal(db.get('Iris'), undefined, 'homonym is ambiguous → undefined');
    assert.deepEqual(db.get('Unique'), { inatId: '12', rank: 'species' });
    assert.equal(db.get('Nope'), undefined);
    assert.equal(db.getAll('Iris').length, 2);
});
