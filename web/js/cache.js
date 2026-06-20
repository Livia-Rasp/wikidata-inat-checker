// localStorage-backed helpers: persistent key/value caches for the enrichment lookups
// (places, taxon ancestry, Commons category existence, author categories) and the
// "uploaded files" backfill list. All survive reloads and sessions.

/**
 * A namespaced JSON cache over localStorage. Stores one object under `winc-cache-<name>`.
 * Negative results are cacheable too (store `null`), so callers must use has() to tell
 * "looked up, nothing found" from "never looked up".
 */
export class Cache {
    constructor(name) {
        this.key = `winc-cache-${name}`;
        try { this.map = JSON.parse(localStorage.getItem(this.key) || '{}'); }
        catch { this.map = {}; }
    }
    has(k) { return Object.prototype.hasOwnProperty.call(this.map, k); }
    get(k) { return this.map[k]; }
    set(k, v) { this.map[k] = v; this._flush(); return v; }
    _flush() {
        try { localStorage.setItem(this.key, JSON.stringify(this.map)); } catch { /* quota */ }
    }
}

// ---- uploaded-files backfill list (§7.2) -------------------------------------------
// A set of Commons destFile names the user has confirmed uploading. Used to render the
// "uploaded" badge and to export the JSON backfill record.
const UPLOADED_KEY = 'winc-uploaded';

function readUploaded() {
    try { return new Set(JSON.parse(localStorage.getItem(UPLOADED_KEY) || '[]')); }
    catch { return new Set(); }
}
function writeUploaded(set) {
    localStorage.setItem(UPLOADED_KEY, JSON.stringify([...set]));
}

export const uploaded = {
    has(destFile) { return readUploaded().has(destFile); },
    add(destFile) { const s = readUploaded(); s.add(destFile); writeUploaded(s); },
    remove(destFile) { const s = readUploaded(); s.delete(destFile); writeUploaded(s); },
    set(destFile, on) { on ? this.add(destFile) : this.remove(destFile); },
    list() { return [...readUploaded()]; },
    count() { return readUploaded().size; },
    /** The wrapped JSON shape downloaded from the main page (§7.2). */
    exportObject() { return { exported: new Date().toISOString(), uploaded: this.list() }; },
};
