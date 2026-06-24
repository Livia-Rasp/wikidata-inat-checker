// Per-taxon photo gallery. Opened in its own tab as
//   taxon.html?taxon_id=<id>&name=<taxonName>&qid=<qid>
// Queries the (CORS-open) iNaturalist API for all research-grade, Commons-compatibly-
// licensed photos of the taxon, enriches each with location + geographic/author categories,
// and renders a card with a one-click "Upload to Commons" link and a "Mark as uploaded" box.
import { LICENSE_MAP, buildUploadUrl, buildDestFile } from './commonsUpload.js';
import {
    resolvePlaceIds, placeHierarchy, locationString,
    findGeoCategory, findAuthorCategories,
} from './enrich.js';
import { uploaded, p18 } from './cache.js';

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
    const isUp = uploaded.has(destFile);

    const isP18 = qid && p18.get(qid)?.file === destFile;

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

    const cb = el.querySelector('.mark input');
    cb.addEventListener('change', () => {
        uploaded.set(destFile, cb.checked);
        el.classList.toggle('uploaded', cb.checked);
    });

    // Pick exactly one photo as the taxon's Wikidata image (P18). Picking also marks the
    // taxon "done" and uploaded, so it surfaces in the main view's QuickStatements panel.
    // Clicking the already-picked radio clears the selection.
    const radio = el.querySelector('.p18 input');
    if (radio) {
        radio.addEventListener('click', () => {
            if (p18.get(qid)?.file === destFile) {
                radio.checked = false;
                p18.clear(qid);
                el.classList.remove('p18-selected');
                return;
            }
            p18.set(qid, destFile, taxonName);
            localStorage.setItem('done-' + qid, '1');
            uploaded.set(destFile, true);
            cb.checked = true;
            el.classList.add('uploaded');
            document.querySelectorAll('.card.p18-selected').forEach((c) => c.classList.remove('p18-selected'));
            el.classList.add('p18-selected');
        });
    }
    return el;
}

// Compute enrichment for one photo and wire its upload link.
async function enrich(el, { obs, photo }) {
    const hierarchy = placeHierarchy(obs.place_ids);
    const [geo, authorCats] = await Promise.all([
        obs.taxon?.id ? findGeoCategory(obs.taxon.id, hierarchy) : null,
        obs.user?.id ? findAuthorCategories(obs.user.id) : [],
    ]);
    const extraCategories = [geo, ...(authorCats || [])].filter(Boolean);
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
    render();
}
