// @ts-check
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { createTaxaAccessor } from '../lib/getInatTaxaDb.js';

// Build an in-memory taxa index from fixture rows, matching the real schema.
// Each row: [taxon_id, name, rank, ancestry] (ancestry = '/'-joined ancestor ids, no self).
function makeAccessor(rows) {
    const db = new DatabaseSync(':memory:');
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

test('ancestorIds is the ancestry path, and the inverse of descendantInatIds', () => {
    const db = makeAccessor(ROWS);
    assert.deepEqual(db.ancestorIds('99001'), ['48460', '1', '2', '41962', '41970']);
    assert.deepEqual(db.ancestorIds('1'), ['48460']);
    assert.deepEqual(db.ancestorIds('48460'), [], 'the root has no ancestry');
    assert.deepEqual(db.ancestorIds('999999'), [], 'an unknown id has no ancestry');

    // The property the backlog filter depends on: walking up finds the same membership as
    // scanning down, so swapping one for the other cannot change which taxa a clade contains.
    for (const id of ['41970', '42048', '99001']) {
        assert.ok(db.ancestorIds(id).includes('41962'), `${id} is inside Panthera`);
    }
    assert.ok(!db.ancestorIds('70000').includes('41962'), 'Puma is not inside Panthera');
});

test('byId and lineage carry the ids a rail needs to navigate', () => {
    const db = makeAccessor(ROWS);
    assert.deepEqual(db.byId('41962'), { inatId: '41962', name: 'Panthera', rank: 'genus' });
    assert.equal(db.byId('999999'), undefined);

    assert.deepEqual(db.lineage('41970'), [
        { inatId: '1', name: 'Animalia', rank: 'kingdom' },
        { inatId: '2', name: 'Felidae', rank: 'family' },
        { inatId: '41962', name: 'Panthera', rank: 'genus' },
    ]);
    assert.deepEqual(db.lineage('999999'), []);
    // An ancestor that is no longer active is absent from the index and must be skipped, not
    // rendered as a hole in the path.
    const gappy = makeAccessor([['9', 'Orphan', 'species', '48460/1/404404']]);
    assert.deepEqual(gappy.lineage('9'), []);
});

test('suggest is a bounded prefix range, and stops at the prefix', () => {
    const db = makeAccessor([
        ['1', 'Orchidaceae', 'family', '48460/47126'],
        ['2', 'Orchis', 'genus', '48460/47126/1'],
        ['3', 'Orchidantha', 'genus', '48460/47126'],
        ['4', 'Ordo', 'genus', null],          // sorts after 'Orchis' but outside the prefix
        ['5', 'Quercus', 'genus', null],
    ]);
    // Shallowest first, then alphabetical: Orchis is a genus *inside* Orchidaceae, so it sorts
    // below the two taxa one rank up rather than by name alone.
    assert.deepEqual(db.suggest('Orchi').map(r => r.name), ['Orchidaceae', 'Orchidantha', 'Orchis']);
    assert.deepEqual(db.suggest('Orchi', 2).map(r => r.name), ['Orchidaceae', 'Orchidantha']);
    assert.deepEqual(db.suggest('Quercus'), [{ inatId: '5', name: 'Quercus', rank: 'genus' }]);
    assert.deepEqual(db.suggest('Zz'), []);
    assert.deepEqual(db.suggest(''), [], 'an empty prefix has no range to scan');
});

test('suggest surfaces a clade the alphabet would have buried', () => {
    // The real failure this ordering exists for: 'Panth' matched two dozen Panthalis and Panthea
    // *species* alphabetically before ever reaching Panthera, so widening the window never helped.
    const rows = [['9000', 'Panthera', 'genus', '48460/1']];
    for (let i = 0; i < 40; i++) {
        rows.push([`${i}`, `Panthalis species${String(i).padStart(2, '0')}`, 'species', '48460/1/8000']);
    }
    const db = makeAccessor(rows);
    const names = db.suggest('Panth', 5).map(r => r.name);
    assert.equal(names[0], 'Panthera', 'the genus must come first, whatever the alphabet says');
    assert.equal(names.length, 5, 'the species still fill the rest');
});

test('openTaxaDb refuses rather than downloading 189MB', async () => {
    const { openTaxaDb, TaxaIndexUnavailable } = await import('../lib/getInatTaxaDb.js');
    // Only meaningful when the real index is absent; when a developer has one, the accessor path
    // is what runs and the message below is what a fresh checkout would see.
    try {
        const db = openTaxaDb();
        assert.ok(typeof db.allInatIds === 'function', 'an existing index opens read-only');
    } catch (err) {
        assert.ok(err instanceof TaxaIndexUnavailable);
        assert.equal(err.code, 'taxa_index_unavailable');
        // The failure has to say what to do, because the server will never do it.
        assert.match(err.message, /from a terminal/);
    }
});
