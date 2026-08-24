# Screenshots

Generated, not hand-captured. **Do not edit or replace these by hand** — run:

```sh
npm run screenshots
```

`tools/screenshots.mjs` starts the server against a throwaway copy of `data/findings.db`, drives
headless Chromium over the DevTools Protocol, and rewrites every file here. It needs a local
Chromium or Chrome and a findings database with open findings; the copy means a capture run can
never write to the real backlog.

| File | Page |
|---|---|
| `worklist.png` | `web/index.html` — the backlog table and the QuickStatements panel |
| `search.png` | `web/search.html` — clade search, scoped to Orchidaceae |
| `area.jpg` | `web/area.html` — the map picker, scoped to 15km around Munich |
| `gallery.jpg` | `web/taxon.html` — one taxon's iNaturalist photos |
| `demo.gif` | the worklist → gallery → QuickStatements → confirm loop, from `npm run record` |

## The recording

```sh
npm run record
```

`tools/record.mjs` shares its plumbing with the screenshots through `tools/cdp.mjs`: the same CDP
client, the same throwaway database copy, the same pinned dark theme. It additionally needs
**ffmpeg**, which encodes the captured frames through a generated 256-colour palette.

**The confirm at the end is real.** Before recording anything, the script asks live Wikidata which
of the open findings already carries both halves of this app's edit, the image (P18) and the
Commons-category sitelink. It drives the demo with that taxon, so the confirm succeeds because it
genuinely should. Nothing is stubbed. If no such taxon exists in the backlog the script stops and
says so, rather than recording a confirm that fails.

That also means the subject changes over time, as taxa get fixed upstream. That is fine. The point
being demonstrated is the loop, not the species.

`area.jpg` needs live network access to OpenStreetMap's tile servers at capture time — the map
itself is vendored (`web/vendor/leaflet/`), but the tiles it draws are always fetched fresh, the
same as every other page's iNat/Wikidata calls. It is a JPEG rather than a PNG for the same reason
`gallery.jpg` is: map tiles are photographic-density raster content that PNG compresses badly (2.9
MB as one, versus a few hundred KB as a JPEG).

**Theme is pinned to dark**, via a CDP `Emulation.setEmulatedMedia` call before every capture —
deliberately, not left to the headless browser's own ambient `prefers-color-scheme` default (which
is what produced it unrequested the first time slice 6's shell added a toggle). Pinning makes a
future regeneration deterministic: without it, a different machine or Chromium version could
silently flip every screenshot's theme with no real UI change behind it.

**Re-run this whenever `web/` changes.** A screenshot is documentation, and it goes stale exactly
like prose does — except that a stale screenshot is harder to notice and more convincing when
wrong. The capture waits for each page's *meaningful* ready state rather than mere page load: the
gallery, in particular, renders its cards with grey "Preparing…" buttons and fills them in as
enrichment resolves, so an early shutter documents an app that looks broken.

The photographs shown in `gallery.jpg` are other people's work, reproduced under their licences —
currently *Bulbophyllum radicans* by Lachlan Copeland (CC BY-SA) and Lucas Christofides (CC BY),
via iNaturalist. The app renders the licence and photographer on every card, so the attribution
travels with the image; keep it that way if you change the taxon.
