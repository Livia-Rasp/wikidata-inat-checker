// The persistent shell: a nav across every page, and the dark/light theme toggle.
//
// No build step and no client router, so this is composition by import — every page's own entry
// script calls mountShell(activePage) once, into a <div id="shell"> it carries in its markup. Four
// workflows share one findings database (images, links, names, area); this is the page whose job is
// picking between them, present everywhere rather than a start page you pass through once.
import { getJson } from './api.js';

const THEME_KEY = 'winc-theme';

/**
 * href: null means the workflow has no page yet — disabled placeholders (links, names) render as
 * a <span>, not a link, and become real the moment their slice lands, with no shell rewrite. kind
 * drives the per-workflow open count; area has none (it is a discovery *scope* on the image kind,
 * not a kind of its own — a count here would either duplicate the images tally or invent a concept
 * the schema does not have).
 */
const NAV = [
    { id: 'images', label: 'Images', href: 'index.html', kind: 'image', enabled: true },
    { id: 'link', label: 'Links', href: null, kind: 'link', enabled: false, caption: 'Not yet migrated' },
    { id: 'name', label: 'Names', href: null, kind: 'name', enabled: false, caption: 'Not yet migrated' },
    { id: 'area', label: 'Area', href: 'area.html', kind: null, enabled: true, caption: 'Find species missing photos near a place' },
];

function tileHtml(item, activeId) {
    const classes = ['shell-tile'];
    if (!item.enabled) classes.push('shell-tile-disabled');
    if (item.id === activeId) classes.push('shell-tile-active');
    const count = item.kind ? `<span class="shell-tile-count" data-kind="${item.kind}"></span>` : '';
    const caption = item.caption ? `<span class="shell-tile-caption">${item.caption}</span>` : '';
    const inner = `<span class="shell-tile-label">${item.label}</span>${count}${caption}`;
    return item.enabled && item.href
        ? `<a class="${classes.join(' ')}" href="${item.href}">${inner}</a>`
        : `<span class="${classes.join(' ')}" aria-disabled="true">${inner}</span>`;
}

function storedTheme() {
    try { return localStorage.getItem(THEME_KEY); } catch { return null; }
}

/** Applied as early as mountShell runs, ahead of building the nav markup — the nav's own theme
 *  button needs to open already showing the right label, not flip a beat after paint. */
function applyStoredTheme() {
    const stored = storedTheme();
    if (stored === 'light' || stored === 'dark') document.documentElement.setAttribute('data-theme', stored);
}

/** What the page is actually showing right now: an explicit choice, or the OS preference. */
function effectiveTheme() {
    const attr = document.documentElement.getAttribute('data-theme');
    if (attr === 'light' || attr === 'dark') return attr;
    return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

function updateToggleLabel() {
    const btn = document.getElementById('shell-theme-toggle');
    if (!btn) return;
    const dark = effectiveTheme() === 'dark';
    btn.textContent = dark ? 'Light' : 'Dark';
    btn.setAttribute('aria-label', dark ? 'Switch to light theme' : 'Switch to dark theme');
}

function toggleTheme() {
    const next = effectiveTheme() === 'dark' ? 'light' : 'dark';
    document.documentElement.setAttribute('data-theme', next);
    try { localStorage.setItem(THEME_KEY, next); } catch { /* private browsing, storage full, etc. */ }
    updateToggleLabel();
}

/** @param {'images'|'link'|'name'|'area'} activePage */
export async function mountShell(activePage) {
    const root = document.getElementById('shell');
    if (!root) return;

    applyStoredTheme();

    root.innerHTML = `
        <div class="shell-brand">iNat → Commons</div>
        <nav class="shell-nav" aria-label="Checker workflows">
            ${NAV.map((item) => tileHtml(item, activePage)).join('')}
        </nav>
        <button id="shell-theme-toggle" class="shell-theme-toggle" type="button"></button>
    `;
    updateToggleLabel();
    document.getElementById('shell-theme-toggle').addEventListener('click', toggleTheme);

    // Best effort: a slow or failed count must not hold up the tile it belongs to, let alone the
    // page underneath the shell.
    await Promise.all(NAV.filter((item) => item.kind).map(async (item) => {
        try {
            const data = await getJson(`api/findings?kind=${item.kind}&status=open&limit=1`);
            const el = root.querySelector(`.shell-tile-count[data-kind="${item.kind}"]`);
            if (el) el.textContent = `${data.total} open`;
        } catch { /* the tile shows no count rather than a stale or wrong one */ }
    }));
}
