// An opaque, per-browser-profile id — not an identity or auth mechanism, just a label so the
// server can tell "every known client has now skipped this" apart from "one person passed on it".
// See docs/findings-db-roadmap.md's multi-user skip section (slice 8b) for why this exists: a
// single global `skipped` status let one tester's Skip silently hide a taxon from everyone else.
const KEY = 'winc-client-id';

function generate() {
    if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID();
    // A browser/context without crypto.randomUUID (very old, or a non-secure context) still needs
    // *an* opaque label — it does not need to be cryptographically unguessable to serve its
    // purpose here.
    return `c-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

let cached = null;

/** This browser profile's opaque id, generated once and persisted. */
export function clientId() {
    if (cached) return cached;
    try {
        cached = localStorage.getItem(KEY);
        if (!cached) { cached = generate(); localStorage.setItem(KEY, cached); }
    } catch {
        cached = generate(); // private browsing / storage disabled: works for this page load only
    }
    return cached;
}
