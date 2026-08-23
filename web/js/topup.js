// Topping up the backlog: starting a discovery run, watching it, cancelling it.
//
// A run takes minutes in a forked child on the server, so this starts one and then polls — no
// long-lived connection to keep alive, and a reload or a second tab picks up a run in progress.
//
// Moved out of main.js in slice 5c, when the scope form moved to the search page: the list is the
// work you are working through, and finding more work belongs where you go looking for it. The
// caller supplies the scope, so this module never reads a form.

import { getJson, postJson } from './api.js';

/** Human-readable progress. The counts differ per phase, so each says only what it knows. */
export function describe(s) {
    if (s.state === 'running') {
        const c = s.counts ?? {};
        if (s.phase === 'querying') return 'Asking Wikidata which taxa still need an image…';
        if (s.phase === 'checking') {
            return c.batches
                ? `Checking iNaturalist for photos — batch ${c.batch} of ${c.batches}, ${c.matched ?? 0} with photos so far.`
                : `Checking ${c.taxa ?? '…'} taxa against iNaturalist…`;
        }
        if (s.phase === 'recording') return `Recording batch ${c.batch} of ${c.batches} — ${c.open ?? 0} to work on so far.`;
        return 'Starting…';
    }
    if (s.state === 'done') return `Done: ${s.counts?.open ?? 0} new taxa to work on.`;
    if (s.state === 'cancelled') return `Cancelled — ${s.counts?.open ?? 0} found before stopping.`;
    if (s.state === 'error') return `Failed: ${s.error?.message ?? 'unknown error'}`;
    return '';
}

/**
 * @param {{
 *   onStatus: (s: object, running: boolean) => void,
 *   onSettled?: (s: object) => void,
 *   intervalMs?: number,
 * }} opts
 */
export function createTopup({ onStatus, onSettled = () => {}, intervalMs = 2000 }) {
    let poller = null;

    async function poll() {
        try {
            const s = await getJson('api/discover/status');
            const running = s.state === 'running';
            onStatus(s, running);
            if (!running && poller) {
                clearInterval(poller);
                poller = null;
                if (s.state === 'done' || s.state === 'cancelled') onSettled(s);
            }
            return s;
        } catch {
            // A poll that fails is not worth a message of its own; the next one usually works.
            return null;
        }
    }

    function watch() {
        if (poller) return;
        poller = setInterval(poll, intervalMs);
        poll();
    }

    return {
        poll,
        watch,

        /** @param {{taxon?: string, iucn?: string, lat?: number, lng?: number, radius?: number, limit?: number}} scope */
        async start(scope) {
            const body = { limit: scope.limit ?? 200 };
            if (scope.taxon) body.taxon = scope.taxon;
            if (scope.iucn) body.iucn = scope.iucn;
            if (scope.lat != null) { body.lat = scope.lat; body.lng = scope.lng; body.radius = scope.radius; }
            await postJson('api/discover', body);
            watch();
        },

        async cancel() {
            // Re-read the status first, so this cannot cancel a run that started in the meantime.
            const s = await getJson('api/discover/status');
            await postJson('api/discover/cancel', s.runId ? { runId: s.runId } : {});
        },

        stop() {
            if (poller) { clearInterval(poller); poller = null; }
        },
    };
}
