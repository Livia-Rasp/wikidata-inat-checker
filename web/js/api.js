// Talking to this app's own backend. Every path is relative, like the rest of web/, so the app
// still works mounted under a reverse-proxy subpath.
//
// Writes send `content-type: application/json` because the server's write guard requires it —
// Fastify parses text/plain by default and a cross-origin form can send exactly that, so the
// content type is part of the CSRF defence rather than a formality (docs/security.md).

/** @param {string} path */
export async function getJson(path) {
    const res = await fetch(path, { cache: 'no-store' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
}

/**
 * @param {string} path
 * @param {unknown} body
 */
export async function postJson(path, body = {}) {
    const res = await fetch(path, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
    });
    let payload = null;
    try { payload = await res.json(); } catch { /* an empty or non-JSON error body */ }
    if (!res.ok) {
        const err = new Error(payload?.message || payload?.error || `HTTP ${res.status}`);
        // @ts-ignore — carried so callers can tell "try again" (503) from "that was refused" (4xx)
        err.status = res.status;
        throw err;
    }
    return payload;
}
