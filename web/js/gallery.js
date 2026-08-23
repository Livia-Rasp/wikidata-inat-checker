// Per-taxon photo gallery. Opened in its own tab as
//   taxon.html?taxon_id=<id>&name=<taxonName>&qid=<qid>
// Queries the (CORS-open) iNaturalist API for all research-grade, Commons-compatibly-
// licensed photos of the taxon, enriches each with location + geographic/author categories,
// and renders a card with a one-click "Upload to Commons" link and a "Mark as uploaded" box.
import { LICENSE_MAP, buildUploadUrl, buildDestFile } from './commonsUpload.js';
import {
    resolvePlaceIds, placeHierarchy, locationString,
    geocodePlaces, mergeGeocodedPlaces,
    findGeoCategories, findAuthorCategories,
} from './enrich.js';
import { state } from './state.js';
import { mountShell } from './shell.js';

mountShell('images');

const API = 'https://api.inaturalist.org/v1/observations';
const PER_PAGE = 200;
const MAX_PAGE = 50; // iNat caps the result window at ~10,000 (50 * 200)
const LICENSES = Object.keys(LICENSE_MAP).join(',');

const params = new URLSearchParams(location.search);
const taxonId = params.get('taxon_id');
const taxonName = params.get('name') || '';
const qid = params.get('qid') || '';

let sort = 'votes'; // 'votes' (most faved) | 'created_at' (newest)

const $ = (id) => document.getElementById(id);
function escapeHtml(s) {
    return (s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function setHeader() {
    document.title = `${taxonName} — photos`;
    $('taxon-name').textContent = taxonName;
    const links = [];
    if (qid) links.push(`<a href="https://www.wikidata.org/wiki/${qid}" target="_blank">${qid}</a>`);
    if (taxonId) links.push(`<a href="https://www.inaturalist.org/taxa/${taxonId}" target="_blank">iNat taxon ${taxonId}</a>`);
    $('taxon-links').innerHTML = links.join(' · ');
}

async function fetchAllPhotos() {
    const out = [];
    for (let page = 1; page <= MAX_PAGE; page++) {
        const q = new URLSearchParams({
            taxon_id: taxonId, photo_license: LICENSES, quality_grade: 'research',
            order_by: sort, order: 'desc', per_page: String(PER_PAGE), page: String(page),
            photos: 'true', locale: 'en',
        });
        const r = await fetch(`${API}?${q}`);
        if (!r.ok) throw new Error(`iNat HTTP ${r.status}`);
        const data = await r.json();
        for (const obs of data.results || []) {
            for (const photo of obs.photos || []) {
                if (LICENSE_MAP[photo.license_code]) out.push({ obs, photo });
            }
        }
        if (page * PER_PAGE >= (data.total_results || 0)) break;
    }
    return out;
}

// A card starts with the thumbnail + meta + a "preparing" upload button, then is filled in
// once async enrichment for that photo completes.
function card({ obs, photo }) {
    const thumb = photo.url.replace('square', 'medium');
    const observer = obs.user?.name?.trim() || obs.user?.login || 'unknown';
    const faves = obs.faves_count ?? 0;
    const lic = photo.license_code.toUpperCase();
    const destFile = buildDestFile({ photo, taxonName });
    const isUp = state.isUploaded(destFile);

    const isP18 = qid && state.pickFor(qid)?.destFile === destFile;

    const el = document.createElement('div');
    el.className = 'card' + (isUp ? ' uploaded' : '') + (isP18 ? ' p18-selected' : '');
    el.innerHTML = `
      <a class="thumb" href="https://www.inaturalist.org/photos/${photo.id}" target="_blank">
        <img loading="lazy" src="${thumb}" alt="">
        <span class="badge">uploaded</span>
      </a>
      <div class="meta">
        <span class="lic">${lic}</span>
        <span class="obs">by ${escapeHtml(observer)}</span>
        <span class="faves">★ ${faves}</span>
      </div>
      <a class="upload disabled" aria-disabled="true">Preparing…</a>
      <label class="mark"><input type="checkbox" ${isUp ? 'checked' : ''}> Mark as uploaded</label>
      ${qid ? `<label class="p18"><input type="radio" name="p18-pick" ${isP18 ? 'checked' : ''}> Use as Wikidata image (P18)</label>` : ''}`;

    /** Server writes can fail; the checkbox must not silently disagree with the database. */
    const save = async (body, revert) => {
        try {
            await state.setUpload(body);
        } catch (e) {
            revert();
            $('status').textContent = `Could not save: ${e.message}`;
        }
    };

    const cb = el.querySelector('.mark input');
    cb.addEventListener('change', () => {
        el.classList.toggle('uploaded', cb.checked);
        save(
            { destFile, qid: qid || undefined, photoId: String(photo.id), taxonName, uploaded: cb.checked },
            () => { cb.checked = !cb.checked; el.classList.toggle('uploaded', cb.checked); });
    });

    // Pick exactly one photo as the taxon's Wikidata image (P18). Picking marks the photo
    // uploaded too, but — unlike before slice 4 — it does *not* mark the taxon done: the pick is
    // an intention to edit, and only Wikidata itself can say the edit happened. Clicking the
    // already-picked radio clears the selection.
    const radio = el.querySelector('.p18 input');
    if (radio) {
        radio.addEventListener('click', () => {
            const picked = state.pickFor(qid)?.destFile === destFile;
            if (picked) {
                radio.checked = false;
                el.classList.remove('p18-selected');
                save({ destFile, qid, taxonName, uploaded: true, p18: false },
                    () => { radio.checked = true; el.classList.add('p18-selected'); });
                return;
            }
            cb.checked = true;
            el.classList.add('uploaded');
            document.querySelectorAll('.card.p18-selected').forEach((c) => c.classList.remove('p18-selected'));
            el.classList.add('p18-selected');
            save(
                { destFile, qid, photoId: String(photo.id), taxonName, uploaded: true, p18: true },
                () => { radio.checked = false; el.classList.remove('p18-selected'); });
        });
    }
    return el;
}

// Compute enrichment for one photo and wire its upload link.
async function enrich(el, { obs, photo }) {
    const hierarchy = placeHierarchy(obs.place_ids);
    // Fill in finer/missing place levels (municipality, county) by reverse-geocoding the point,
    // but only when the coordinates are precise enough (geocodePlaces gates obscured/coarse ones).
    mergeGeocodedPlaces(hierarchy, await geocodePlaces(obs));
    const [geoCats, authorCats] = await Promise.all([
        obs.taxon?.id ? findGeoCategories(obs.taxon.id, hierarchy) : [],
        obs.user?.id ? findAuthorCategories(obs.user.id) : [],
    ]);
    const extraCategories = [...(geoCats || []), ...(authorCats || [])].filter(Boolean);
    const url = buildUploadUrl({
        observation: obs, photo, taxonName,
        location: locationString(hierarchy), country: hierarchy.country || '',
        extraCategories,
    });
    const link = el.querySelector('.upload');
    if (url) {
        link.classList.remove('disabled');
        link.removeAttribute('aria-disabled');
        link.href = url;
        link.target = '_blank';
        link.textContent = 'Upload to Commons ↗';
    } else {
        link.textContent = 'Unsupported license';
    }
}

async function render() {
    const grid = $('grid');
    grid.innerHTML = '';
    $('status').textContent = 'Loading photos…';
    try {
        const photos = await fetchAllPhotos();
        $('status').textContent = photos.length
            ? `${photos.length} photo${photos.length === 1 ? '' : 's'} — preparing upload links…`
            : 'No Commons-compatible photos found for this taxon.';

        // Render cards immediately so thumbnails appear fast.
        const els = photos.map((p) => { const el = card(p); grid.appendChild(el); return el; });

        // Resolve all place IDs once, then enrich each card (caches make repeats cheap).
        await resolvePlaceIds(photos.flatMap((p) => p.obs.place_ids || []));
        for (let i = 0; i < photos.length; i++) await enrich(els[i], photos[i]);

        $('status').textContent = `${photos.length} photo${photos.length === 1 ? '' : 's'}`;
    } catch (e) {
        $('status').textContent = `Error: ${e.message}`;
    }
}

function setSort(next) {
    if (sort === next) return;
    sort = next;
    document.querySelectorAll('#sort button').forEach((b) => b.classList.toggle('active', b.dataset.sort === sort));
    render();
}

if (!taxonId) {
    $('status').textContent = 'Missing taxon_id in URL.';
} else {
    setHeader();
    document.querySelectorAll('#sort button').forEach((b) => {
        b.classList.toggle('active', b.dataset.sort === sort);
        b.addEventListener('click', () => setSort(b.dataset.sort));
    });
    // The uploaded/picked state must be in memory before the first card renders — card() asks
    // for it synchronously — so this is awaited rather than raced with the photo fetch.
    state.load()
        .then(render)
        .catch((e) => { $('status').textContent = `Could not reach the server (${e.message}).`; });
}
