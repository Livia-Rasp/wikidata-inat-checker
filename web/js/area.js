// The area page: pick a point and a radius on a map (or type coordinates), preview the
// most-observed species missing a Wikidata image there for free, and optionally spend Wikidata
// and iNaturalist's API budget adding the rest to the shared worklist.
//
// Preview and Add to worklist are deliberately two different actions, not one. Preview is a read
// — GET /api/discover/area answers fast (bounded to a sample of the most-observed species, no
// per-taxon enrichment) and records nothing. Add to worklist is the write: the same POST /discover
// job runner every other scope uses, running candidates through the normal draft-generation and
// CC-license-check pipeline. Photos and dates for the preview table are fetched lazily, one taxon
// at a time, straight from iNat — the same client-side pattern gallery.js already uses for its own
// cards, and the only way a browser-side fetch can stay a fix rather than reintroduce the shared
// result window lib/areaCandidates.js's fetchAreaEnrichment exists to avoid (see its own comment).
import { getJson } from './api.js';
import { createTopup, describe } from './topup.js';
import { mountShell } from './shell.js';

mountShell('area');

const $ = (id) => document.getElementById(id);
const INAT_OBS = 'https://api.inaturalist.org/v1/observations';
const LAST_AREA_KEY = 'winc-area-last';
// Matches GET /api/discover/area's own schema ceiling — that route answers synchronously, in the
// request handler, so its radius is capped for the server's own request timeout, not politeness.
const PREVIEW_RADIUS_MAX = 50;

function escapeHtml(s) {
    return (s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// ---- the map ----

const map = L.map('map');
L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19,
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank">OpenStreetMap</a> contributors',
}).addTo(map);

// Leaflet measures its container once, at creation — if the flexbox layout around #map hasn't
// settled yet (fonts/tiles still loading, or this script running before layout), it can compute
// too small a size and never notice the container growing to its real one. invalidateSize()
// forces it to re-measure; also wired to window resize, since the layout genuinely changes shape
// across the narrow-viewport breakpoint in styles.css.
requestAnimationFrame(() => map.invalidateSize());
window.addEventListener('resize', () => map.invalidateSize());

let marker = null;
let circle = null;

function placeOnMap(lat, lng, radiusKm) {
    if (!marker) {
        marker = L.marker([lat, lng], { draggable: true }).addTo(map);
        marker.on('dragend', () => {
            const { lat: dLat, lng: dLng } = marker.getLatLng();
            commitChosen(dLat, dLng, chosen?.radius ?? readRadiusField(), { reformatFields: true });
        });
    } else {
        marker.setLatLng([lat, lng]);
    }
    if (!circle) {
        circle = L.circle([lat, lng], { radius: radiusKm * 1000, color: '#3366cc', weight: 2 }).addTo(map);
    } else {
        circle.setLatLng([lat, lng]);
        circle.setRadius(radiusKm * 1000);
    }
}

map.on('click', (e) =>
    commitChosen(e.latlng.lat, e.latlng.lng, chosen?.radius ?? readRadiusField(), { reformatFields: true }));

// ---- the single source of truth: null until a point has actually been chosen ----

/** @type {{lat: number, lng: number, radius: number} | null} */
let chosen = null;

function readRadiusField() {
    const n = Number($('radius').value);
    return Number.isFinite(n) && n > 0 ? n : 10;
}

/**
 * The one place lat/lng/radius actually change from — a click, a drag, a typed edit or a restored
 * last-used point all funnel through here. Always pans, so a pasted coordinate for somewhere off
 * the current view is not left invisible off-screen. `reformatFields` is the one thing that has to
 * differ by caller: the map/drag/restore paths may freely rewrite the three text boxes (nothing
 * there has focus), but a typed edit must never rewrite the field it came from — reformatting the
 * box the user is actively typing into (e.g. `.toFixed(6)`-ing "48.1" mid-digit) resets the cursor
 * and corrupts what they are typing.
 */
function commitChosen(lat, lng, radius, { reformatFields }) {
    chosen = { lat, lng, radius };
    if (reformatFields) {
        $('lat').value = lat.toFixed(6);
        $('lng').value = lng.toFixed(6);
        $('radius').value = String(radius);
    }
    $('radius-slider').value = String(Math.min(radius, Number($('radius-slider').max)));
    placeOnMap(lat, lng, radius);
    map.panTo([lat, lng]);
    updateButtons();
    saveLast(chosen);
}

/** What the typed fields say right now, or null while they don't describe a valid point — a blank
 *  field reads as invalid (not as 0), so an unfilled lat/lng before any point is chosen is never
 *  mistaken for the equator/prime meridian. */
function readTypedFields() {
    const latText = $('lat').value.trim(), lngText = $('lng').value.trim(), radiusText = $('radius').value.trim();
    if (!latText || !lngText || !radiusText) return null;
    const lat = Number(latText), lng = Number(lngText), radius = Number(radiusText);
    if (!Number.isFinite(lat) || lat < -90 || lat > 90) return null;
    if (!Number.isFinite(lng) || lng < -180 || lng > 180) return null;
    if (!Number.isFinite(radius) || radius <= 0) return null;
    return { lat, lng, radius };
}

function onTypedChange() {
    const parsed = readTypedFields();
    if (!parsed) return; // incomplete or invalid mid-edit (e.g. "48.") — chosen keeps its last value
    commitChosen(parsed.lat, parsed.lng, parsed.radius, { reformatFields: false });
}

$('lat').addEventListener('input', onTypedChange);
$('lng').addEventListener('input', onTypedChange);
$('radius').addEventListener('input', onTypedChange);
$('radius-slider').addEventListener('input', () => {
    $('radius').value = $('radius-slider').value; // the slider is not a coordinate text field —
    onTypedChange();                               // safe to set directly, nothing is fighting it
});

// ---- persistence: remember the last-used point, a per-browser convenience only ----

function saveLast(area) {
    try { localStorage.setItem(LAST_AREA_KEY, JSON.stringify(area)); } catch { /* private browsing etc. */ }
}
function loadLast() {
    try { return JSON.parse(localStorage.getItem(LAST_AREA_KEY) ?? 'null'); } catch { return null; }
}

// ---- buttons ----

let topupRunning = false;

function updateButtons() {
    const has = chosen !== null;
    const overPreviewLimit = has && chosen.radius > PREVIEW_RADIUS_MAX;
    $('preview-run').disabled = !has || overPreviewLimit;
    $('worklist-run').disabled = !has || topupRunning;
    $('radius-hint').textContent = overPreviewLimit
        ? `Preview works up to ${PREVIEW_RADIUS_MAX} km; Add to worklist has no such limit.`
        : '';
}

// ---- preview: a read, free, never automatic ----

async function runPreview() {
    if (!chosen) return;
    const area = chosen;
    $('preview-run').disabled = true;
    $('area-status').textContent = 'Looking at the most-observed species here…';
    $('results-table').hidden = true;
    $('results-body').innerHTML = '';
    try {
        const qs = new URLSearchParams({ lat: String(area.lat), lng: String(area.lng), radius: String(area.radius) });
        const body = await getJson(`api/discover/area?${qs}`);
        renderResults(body, area);
    } catch (e) {
        $('area-status').textContent = `Could not preview this area (${e.message}).`;
    } finally {
        updateButtons();
    }
}

function renderResults(body, area) {
    const { qualified, totalSpecies, sampled, mayBeIncomplete } = body;
    $('area-status').textContent = qualified.length === 0
        ? `Checked the ${sampled} most-observed species near here — all already have a Wikidata image.`
        : `${qualified.length} of the ${sampled} most-observed species near here lack a Wikidata image`
          + (mayBeIncomplete ? ` (${totalSpecies} species observed in the area in total — showing the most-observed).` : '.');

    $('results-table').hidden = qualified.length === 0;
    $('results-body').innerHTML = qualified.map((q) => `
        <tr data-inat-id="${escapeHtml(q.inatId)}">
          <td class="taxon-cell"><a href="https://www.inaturalist.org/taxa/${escapeHtml(q.inatId)}" target="_blank"><em>${escapeHtml(q.taxonName)}</em></a>${q.commonName ? ` <span class="common">${escapeHtml(q.commonName)}</span>` : ''}</td>
          <td class="wd-cell"><a href="${escapeHtml(q.wdUri)}" target="_blank">${escapeHtml(q.qid)}</a></td>
          <td class="count-cell">${q.count}</td>
          <td class="date-cell">…</td>
          <td class="photos-cell">…</td>
        </tr>`).join('');

    enrichRows(qualified, area);
}

/** Photos + latest date, one taxon at a time, straight from iNat (CORS-open) — issued from the
 *  browser so the fast preview route never has to block on it. */
async function enrichRows(qualified, area) {
    for (const q of qualified) {
        const row = document.querySelector(`tr[data-inat-id="${CSS.escape(q.inatId)}"]`);
        if (!row) continue; // a fresh preview replaced the table while this one was in flight
        try {
            const params = new URLSearchParams({
                taxon_id: q.inatId,
                lat: String(area.lat), lng: String(area.lng), radius: String(area.radius),
                quality_grade: 'research', per_page: '20', order_by: 'observed_on', order: 'desc',
            });
            const res = await fetch(`${INAT_OBS}?${params}`);
            const data = await res.json();
            const results = data.results ?? [];
            row.querySelector('.date-cell').textContent = results[0]?.observed_on ?? '';
            const photos = results.filter((o) => o.photos?.length).slice(0, 3);
            row.querySelector('.photos-cell').innerHTML = photos.length
                ? photos.map((o) => `<a href="https://www.inaturalist.org/observations/${o.id}" target="_blank"><img src="${escapeHtml(o.photos[0].url.replace('square', 'small'))}" alt="" loading="lazy"></a>`).join('')
                : '<span class="no-photo">no photo found</span>';
        } catch {
            row.querySelector('.date-cell').textContent = '';
            row.querySelector('.photos-cell').textContent = '';
        }
    }
}

// ---- add to worklist: the write, reusing the same job runner every other scope uses ----

const topup = createTopup({
    onStatus: (s, running) => {
        topupRunning = running;
        updateButtons();
        $('worklist-cancel').hidden = !running;
        $('area-status').textContent = describe(s);
    },
    onSettled: (s) => { $('area-status').textContent = describe(s); },
});

async function runWorklist() {
    if (!chosen) return;
    $('area-status').textContent = 'Starting…';
    try {
        await topup.start({ ...chosen, limit: 500 });
    } catch (e) {
        $('area-status').textContent = e.message;
    }
}

// ---- wiring ----

$('preview-run').addEventListener('click', runPreview);
$('worklist-run').addEventListener('click', runWorklist);
$('worklist-cancel').addEventListener('click', () => {
    $('area-status').textContent = 'Stopping — the taxa already checked are kept.';
    topup.cancel().catch((e) => { $('area-status').textContent = e.message; });
});

// ---- boot ----

/** ?lat=&lng=&radius= — a deep link, the same way search.html reads ?taxon=. Takes priority over
 *  the remembered last-used point: a link someone was actually given should win over whatever this
 *  browser happened to have open last. */
function fromQueryString() {
    const p = new URLSearchParams(location.search);
    const lat = Number(p.get('lat')), lng = Number(p.get('lng')), radius = Number(p.get('radius'));
    if (!Number.isFinite(lat) || !Number.isFinite(lng) || !Number.isFinite(radius) || radius <= 0) return null;
    return { lat, lng, radius };
}

const initial = fromQueryString() ?? loadLast();
if (initial) {
    map.setView([initial.lat, initial.lng], 11);
    commitChosen(initial.lat, initial.lng, initial.radius, { reformatFields: true });
} else {
    map.setView([20, 0], 2); // no prior point — a wide view, waiting for a click
}
updateButtons();
// Adopts a run started in another tab, same as search.js.
topup.poll().then((s) => { if (s?.state === 'running') topup.watch(); });
