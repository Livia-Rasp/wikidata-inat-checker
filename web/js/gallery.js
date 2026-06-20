// Per-taxon photo gallery. Opened in its own tab as
//   taxon.html?taxon_id=<id>&name=<taxonName>&qid=<qid>
// Queries the (CORS-open) iNaturalist API directly from the browser for all
// research-grade, Commons-compatibly-licensed photos of the taxon, and renders each
// as a card with a one-click "Upload to Commons" link.
import { LICENSE_MAP, buildUploadUrl } from './commonsUpload.js';

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
            taxon_id: taxonId,
            photo_license: LICENSES,
            quality_grade: 'research',
            order_by: sort,
            order: 'desc',
            per_page: String(PER_PAGE),
            page: String(page),
            photos: 'true',
        });
        const r = await fetch(`${API}?${q}`);
        if (!r.ok) throw new Error(`iNat HTTP ${r.status}`);
        const data = await r.json();
        for (const obs of data.results || []) {
            for (const photo of obs.photos || []) {
                // photo_license filters at the observation level; keep only the
                // individual photos whose own license is Commons-compatible.
                if (LICENSE_MAP[photo.license_code]) out.push({ obs, photo });
            }
        }
        if (page * PER_PAGE >= (data.total_results || 0)) break;
    }
    return out;
}

function card({ obs, photo }) {
    const thumb = photo.url.replace('square', 'medium');
    const uploadUrl = buildUploadUrl({ observation: obs, photo, taxonName });
    const observer = obs.user?.name?.trim() || obs.user?.login || 'unknown';
    const faves = obs.faves_count ?? 0;
    const lic = photo.license_code.toUpperCase();

    const el = document.createElement('div');
    el.className = 'card';
    el.innerHTML = `
      <a class="thumb" href="https://www.inaturalist.org/observations/${obs.id}" target="_blank">
        <img loading="lazy" src="${thumb}" alt="">
      </a>
      <div class="meta">
        <span class="lic">${lic}</span>
        <span class="obs">by ${escapeHtml(observer)}</span>
        <span class="faves">★ ${faves}</span>
      </div>
      <a class="upload" href="${uploadUrl}" target="_blank">Upload to Commons ↗</a>`;
    return el;
}

function escapeHtml(s) {
    return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

async function render() {
    const grid = $('grid');
    grid.innerHTML = '';
    $('status').textContent = 'Loading photos…';
    try {
        const photos = await fetchAllPhotos();
        $('status').textContent = photos.length
            ? `${photos.length} photo${photos.length === 1 ? '' : 's'}`
            : 'No Commons-compatible photos found for this taxon.';
        const frag = document.createDocumentFragment();
        for (const p of photos) frag.appendChild(card(p));
        grid.appendChild(frag);
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
