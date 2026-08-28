// @ts-check
// Fixtures otherwise redefined identically across test/*.test.js: a real in-memory findings
// store, and a real in-memory taxa-index accessor. Sharing the schema/insert boilerplate here
// means a schema change can't silently drift out of sync between one copy and the rest.
import { DatabaseSync } from 'node:sqlite';
import { createFindingsStore, migrate } from '../lib/db.js';
import { createTaxaAccessor } from '../lib/getInatTaxaDb.js';

/** A fresh in-memory findings store, migrated to the current schema. */
export function makeStore() {
    const db = new DatabaseSync(':memory:');
    migrate(db);
    return { db, store: createFindingsStore(db) };
}

/**
 * A fresh in-memory taxa-index accessor seeded with `rows` — each a
 * `[taxonId, name, rank, ancestry]` tuple, `ancestry` a '/'-joined ancestor-id chain or null.
 * Callers keep their own default fixture rows via a thin per-file wrapper; only the
 * schema/insert logic lives here.
 * @param {(string|null)[][]} rows
 */
export function makeTaxaDb(rows) {
    const db = new DatabaseSync(':memory:');
    db.exec('CREATE TABLE taxa (taxon_id TEXT PRIMARY KEY, name TEXT NOT NULL, rank TEXT NOT NULL, ancestry TEXT);');
    const ins = db.prepare('INSERT INTO taxa VALUES (?, ?, ?, ?)');
    for (const [id, name, rank, ancestry] of rows) ins.run(id, name, rank, ancestry ?? null);
    return createTaxaAccessor(db);
}
