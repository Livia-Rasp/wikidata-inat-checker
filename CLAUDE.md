# CLAUDE.md

Guidance for Claude Code (claude.ai/code) when working in this repository.

## Commands

```sh
node checkImages.js --limit 500 --iucn VU   # image checker (--limit, --iucn optional)
npm run images -- --limit 500 --iucn VU     # same via npm (-- required to forward flags)

node checkNames.js --limit 500 --iucn CR    # vernacular names checker (zero-P1843 taxa only by default)
node checkNames.js --limit 500 --all        # include taxa that already have some P1843
npm run names -- --limit 500 --iucn CR      # same via npm

node checkLinks.js --limit 200 --iucn EN    # iNat links checker (--limit, --iucn optional)
node checkLinks.js --limit 200 --auto       # also write links-auto.qs (certain matches only)
npm run links -- --limit 200 --auto         # same via npm
node checkLinksStats.js                     # stats: per-IUCN match/ambig/no-match table, no HTML
npm run linkStats                           # same via npm

node checkArea.js --lat 48.147 --lng 11.589 --radius 10   # area checker (all three required)
npm run area -- --lat 48.147 --lng 11.589 --radius 10     # same via npm

node draftCategory.js Q14625955            # print a Commons category draft for a taxon QID
npm run draft -- Q14625955 Q10459793       # same via npm (accepts multiple QIDs)

npm run web                                 # serve the iNat→Commons upload app (web/), localhost:8080
```

No build step, no tests. All outputs and caches are gitignored.

- **Outputs:** `drafts.html` + `web/data/taxa.json` (images); `names.html`; `links.html` + `links-ambiguous.html` + `links-auto.qs` + `inat-links-conflicts.json` (links); `area.html`.
- **Caches:** the image/names/links checkers each keep a cache file (`cache-images.json` / `cache-names.json` / `cache-links.json`) so re-runs skip already-checked taxa — delete it to force a full re-scan. The image checker also writes `cache-commons-cats.json` (Commons `Endemic <group> of <place>` category existence, reused across runs). The area checker has no cache.
- **Upload app:** `checkImages.js` also exports `web/data/taxa.json`; `npm run web` serves the static `web/` app that browses those taxa, lists their CC-licensed iNat photos, and opens a pre-filled Commons upload form per photo. The generated file description is enriched (not a stub): an `{{en|<common> (''scientific'') in County, State, Country}}` description from the observation's identified taxon, a `{{Taken on|date|location=Country}}` date, and best-effort **geographic taxon categories** (`<Taxon> of <Place>`, e.g. `Picidae of Texas`) and **author categories** (via Commons `{{Inaturalist user}}` + Wikidata P12022). Users mark photos uploaded (a `localStorage` backfill list, downloadable as JSON). Design/details in [docs/commons-upload.md](docs/commons-upload.md) and [docs/commons-upload-dev.md](docs/commons-upload-dev.md) (§7).

## Architecture

Six entry scripts (five tools), each wiring together shared modules; data flows in memory. Shared building blocks: the local iNat taxa SQLite index (`getInatTaxaDb.js`) and the Wikidata SPARQL / CirrusSearch helpers (`utils.js`).

| Tool | Entry | Finds | Docs |
|---|---|---|---|
| Image checker | `checkImages.js` | taxa with P3151 but no image (P18) | [docs/images.md](docs/images.md) |
| Vernacular names | `checkNames.js` | iNat common names missing from P1843 | [docs/names.md](docs/names.md) |
| iNat links | `checkLinks.js` | taxa with a name but no P3151, matched to iNat | [docs/links.md](docs/links.md) |
| iNat links stats | `checkLinksStats.js` | per-IUCN match/ambig breakdown (no HTML) | [docs/links.md](docs/links.md) |
| Area checker | `checkArea.js` | image-less taxa observed near a location | [docs/area.md](docs/area.md) |
| Category draft | `draftCategory.js` | Commons category draft for given taxon QID(s) | [docs/images.md](docs/images.md#generating-a-single-category-draft) |
| Upload app | `web/` (`npm run web`) | assisted iNat→Commons photo upload (pre-filled form) | [docs/commons-upload.md](docs/commons-upload.md) |

The upload app is a static, backend-free `web/` folder (plain HTML/JS/CSS) that consumes `web/data/taxa.json` (exported by `checkImages.js` via `generateImagesJson.js`) and calls the iNaturalist API directly from the browser. `web/js/commonsUpload.js` builds the pre-filled `Special:Upload` URL and file-page wikitext; `web/js/enrich.js` resolves the place hierarchy, taxon ancestry, and geographic/author categories (iNat + Commons + Wikidata Query Service, all CORS-open); `web/js/cache.js` persists every lookup and the uploaded-files list in `localStorage`. It is self-contained for an eventual spin-out into its own repo — see [docs/commons-upload.md](docs/commons-upload.md) and [docs/commons-upload-dev.md](docs/commons-upload-dev.md).

Reusable, app-agnostic Commons/iNaturalist/Wikidata integration recipes (Special:Upload prefill, copy-upload allowlist, category-existence checks, `{{Taken on}}`, `<Taxon> of <Place>` and author categories, P12022) are collected in [docs/commons-integration.md](docs/commons-integration.md) — the reference for building further Commons-upload tools.

Module-wiring diagrams and implementation details live in [`docs/dev.md`](docs/dev.md) — read it on demand. Topics covered there:

- **Module wiring** — per-tool data-flow diagrams (which module calls what)
- **SQLite taxa index** — schema, `get()`/`getAll()`/`getAncestors()`/`allNames()`/`allInatIds()`, stateofmatter filter (`getInatTaxaDb.js`)
- **zh-hans/zh-hant normalization** — why `zh-CN`/`zh-TW` are remapped (`getInatNames.js`)
- **Ancestor traversal depth** — why the cap is `MAX_ANCESTOR_DEPTH` (40) rounds; reaching the kingdom for endemic categories (`generateWikitext.js`)
- **Commons Taxonavigation templates** — wrappers, suffixed families, Fungorum, IUCN categories, placement rules (`generateWikitext.js`)
- **SPARQL & CirrusSearch** — TSV format, why WDQS can't scan the big filtered sets, the query-by-value inversion (by name for links, by iNat ID for images) (`utils.js`, `checkLinks.js`, `checkLinksStats.js`, `checkImages.js`)
- **Taxonomy tree comparison & `--auto` filter** — `compareAncestorTrees()`, Noctuidae/Erebidae disagreement (`utils.js`, `checkLinks.js`)
- **Wikidata QID reference** — rank QIDs, IUCN status/category QIDs, `{{IUCN}}` logic, the S248 source item

## Key Wikidata properties

| Property | Meaning |
|---|---|
| P3151 | iNaturalist taxon ID |
| P18 | image |
| P171 | parent taxon |
| P105 | taxon rank |
| P225 | taxon name (scientific) |
| P685 | NCBI taxonomy ID |
| P830 | Encyclopedia of Life ID |
| P962 | MycoBank taxon name ID |
| P1391 | Index Fungorum taxon ID |
| P141 | IUCN conservation status |
| P627 | IUCN Red List taxon ID |
| P1843 | vernacular name (monolingualtext) |
| P13177 | homonymous taxon |
| P183 | endemic to (drives `Endemic <group> of <place>` Commons categories) |

The specific QIDs (taxon ranks, IUCN statuses, source items) and how P141/P627 drive the `{{IUCN}}` template are in [`docs/dev.md`](docs/dev.md#wikidata-qid-reference).
