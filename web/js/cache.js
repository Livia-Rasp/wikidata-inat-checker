// localStorage-backed helpers.
//
// Only two kinds of thing belong here now. **Lookup caches** (places, taxon ancestry, Commons
// category existence, author categories) — derived from public APIs, regenerable, and worthless to
// anyone else, so a browser profile is the right home. And the **legacy readers** below, which
// exist solely to hand the old worklist state to the server once and then delete it.
//
// The worklist state itself — what was uploaded, which photo is a taxon's P18 pick, what is done —
// moved to the findings database in slice 4. See state.js.

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

// ---- the pre-slice-4 worklist state, for one-time import ------------------------------
const UPLOADED_KEY = 'winc-uploaded';
const P18_KEY = 'winc-p18';

function readJson(key, fallback) {
    try { return JSON.parse(localStorage.getItem(key) || '') ?? fallback; }
    catch { return fallback; }
}

/**
 * The main report's own done marks and nobody else's. This used to take the current backlog's qids
 * and test each one, which stopped working when that page started showing a hundred rows at a time
 * rather than all of them — the banner would then only offer to import what was on screen.
 *
 * The anchoring is what replaces that filter, and it is the whole point: the generated HTML reports
 * write `done-<segment>-<qid>` for other finding kinds (`done-links-Q123`), and the segment makes
 * those fail this pattern. They are not ours to sweep up.
 */
const DONE_KEY = /^done-(Q[0-9]+)$/;

function doneQids() {
    const out = [];
    for (let i = 0; i < localStorage.length; i++) {
        const m = DONE_KEY.exec(localStorage.key(i) ?? '');
        if (m) out.push(m[1]);
    }
    return out;
}

export const legacy = {
    /** Whatever this browser profile still holds. */
    read() {
        return {
            done: doneQids(),
            uploaded: readJson(UPLOADED_KEY, []),
            picks: readJson(P18_KEY, {}),
        };
    },

    /** Is there anything left to import? */
    has() {
        const { done, uploaded, picks } = this.read();
        return done.length > 0 || uploaded.length > 0 || Object.keys(picks).length > 0;
    },

    /** Only ever called after the server has acknowledged the import. */
    clear() {
        for (const qid of doneQids()) localStorage.removeItem('done-' + qid);
        localStorage.removeItem(UPLOADED_KEY);
        localStorage.removeItem(P18_KEY);
    },
};
