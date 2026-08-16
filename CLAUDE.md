# CLAUDE.md

Guidance for Claude Code (claude.ai/code) when working in this repository.

Project-level ToDos live in the Obsidian vault, not here — query them with `vault_tasks` /
`vault_overview` (`winged-eye-obsidian` MCP, read-only; never write to the vault).

## Commands

```sh
node checkImages.js --limit 500 --iucn VU   # image checker (--limit, --iucn optional)
node checkImages.js --taxon Orchidaceae     # scope to a clade (taxon + iNat descendants); name or iNat ID, composes with --iucn/--limit
node checkImages.js --recheck-after 30      # re-examine taxa written off as no-photos >30 days ago (default 90; 0 = all)

node verifyFindings.js                      # re-check the open backlog against live Wikidata, prune what's already fixed
npm run verify -- --limit 200               # same via npm (--limit caps one pass; --kind defaults to image)
npm run images -- --limit 500 --iucn VU     # same via npm (-- required to forward flags)

node checkNames.js --limit 500 --iucn CR    # vernacular names checker (zero-P1843 taxa only by default)
node checkNames.js --limit 500 --all        # include taxa that already have some P1843
npm run names -- --limit 500 --iucn CR      # same via npm

node checkLinks.js --limit 200 --iucn EN    # iNat links checker (--limit, --iucn optional)
node checkLinks.js --limit 200 --auto       # also write output/links-auto.qs (certain matches only)
npm run links -- --limit 200 --auto         # same via npm
node checkLinksStats.js                     # stats: per-IUCN match/ambig/no-match table, no HTML
npm run linkStats                           # same via npm

node checkArea.js --lat 48.147 --lng 11.589 --radius 10   # area checker (all three required)
npm run area -- --lat 48.147 --lng 11.589 --radius 10     # same via npm

node draftCategory.js Q14625955            # print a Commons category draft for a taxon QID
npm run draft -- Q14625955 Q10459793       # same via npm (accepts multiple QIDs)

npm run web                                 # Fastify: serves web/ + the findings API, localhost:8080
                                            # env: PORT, HOST (default 127.0.0.1; a non-loopback
                                            # bind needs ALLOW_REMOTE_WRITES + ALLOWED_HOSTS),
                                            # FINDINGS_DB, LOG_LEVEL, TRUST_PROXY,
                                            # RATE_LIMIT_MAX / RATE_LIMIT_WRITE_MAX / _WINDOW
DISCOVER_ENABLED=1 npm run web              # …and allow discovery from the app (loopback only)

npm test                                    # run the unit suite (Node's built-in runner)
```

No build step. **Tests:** `npm test` runs `node --test` over `test/*.test.js` — a fast, dependency-free unit suite covering the pure logic (arg parsing, `descendantInatIds`/`getAncestors` via an in-memory SQLite fixture, tree comparison, `extractTaxonName`, the report scaffold). No network, so it runs in well under a second; add cases here when touching that logic.

All generated artifacts are gitignored, split into three top-level dirs (created on first write; `lib/paths.js` centralises the paths). Two are disposable, one is not:

- **Outputs → `output/`:** deliverables you act on — `output/drafts.html` (images); `output/names.html`; `output/links.html` + `output/links-ambiguous.html` + `output/links-auto.qs` + `output/inat-links-conflicts.json` (links); `output/area.html`. Safe to delete wholesale; a re-run regenerates them. (The web app has no file contract at all — it reads `GET /api/findings` live.)
- **Caches → `cache/`:** the names/links checkers each keep a cache file (`cache/cache-names.json` / `cache/cache-links.json`) so re-runs skip already-checked taxa — delete it to force a full re-scan. The image checker no longer uses one (see `data/` below), but still writes `cache/cache-commons-cats.json` (Commons `Endemic <group> of <place>` category existence, reused across runs). The area checker has no cache. Kept separate from `output/` so clearing reports doesn't wipe the caches (which would force slow full re-scans). (The large iNat taxa SQLite index lives separately under `~/.cache/wikidata-inat-checker/`; it is derived and gets dropped and rebuilt, so never confuse it with `data/`.)
- **Findings DB → `data/findings.db`: NOT safe to delete.** The image checker records every outcome here instead of a tombstone cache — `open` (photos + a draft), `no_draft` (photos but no P225/family template), `no_photos`, later `done`/`skipped`/`fixed_upstream`/`gone` — so the backlog **accumulates across runs** rather than being overwritten, and `output/drafts.html` + the `/api/findings` endpoint the web app reads render the whole open worklist. Schema v2 adds an `uploads` table (what was uploaded to Commons, and each taxon's pending P18 pick), and `done` is written **only** by a confirm that found the edit live on Wikidata. Negative outcomes carry `checked_at` and expire after `--recheck-after` days (default 90), because photos and P3151 links keep appearing; settled ones never expire. A failed iNat batch records *nothing*, so it retries. SQLite via `node:sqlite`, WAL + `STRICT`, schema version in `PRAGMA user_version` (`lib/db.js`). `npm run verify` re-checks the open backlog against **live Wikidata via the Action API** (never SPARQL, whose lag would report an image still missing right after you added it): findings whose P18 appeared become `fixed_upstream`, merged or deleted items become `gone`, and the reports are re-rendered so they stop offering work already done (`lib/verify.js`). Migrating the other three checkers onto it is [docs/findings-db-roadmap.md](docs/findings-db-roadmap.md) slices 6–8.
- **Upload app:** `npm run web` starts `server/` (Fastify), which serves the `web/` app and the `GET /api/findings` it browses, lists their CC-licensed iNat photos, and opens a pre-filled Commons upload form per photo. The generated file description is enriched (not a stub): an `{{en|<common> (''scientific'') in County, State, Country}}` description from the observation's identified taxon, a `{{Taken on|date|location=Country}}` date, and best-effort **geographic categories** along two axes — a taxon-in-place (`<Taxon> of <Place>`, e.g. `Picidae of Texas`) plus the most-specific **location** category (`Flora/Fauna/Fungi of <place>`, else `Nature of <place>` for all organisms, else the Commons-disambiguated plain place, e.g. `Grayson County, Texas` / `Williston, Vermont`), with any category nested inside the other dropped; the finest place comes from iNat `place_ids` augmented by an OSM **Nominatim** reverse-geocode (`geocodePlaces`/`reverseGeocode`/`mergeGeocodedPlaces` in `enrich.js`, cached + throttled to ~1 req/s, **skipped for obscured/coarse coordinates** so threatened-taxon points aren't mis-located; disambiguation pages and diacritics are handled too), and non-US admin divisions are resolved to their **exact** Commons category via Wikidata (province ISO 3166-2 → `wdt:P300`, county via `wdt:P131`+name → `wdt:P373`; `resolvePlaceCats` in `enrich.js`, e.g. `Lago Agrio Canton`, `Sucumbíos Province`) — and **author categories** (via Commons `{{Inaturalist user}}` + Wikidata P12022). Users mark photos uploaded (recorded in the `uploads` table, downloadable as JSON). Picking one photo per taxon as **Use as Wikidata image (P18)** queues two QuickStatements — P18 and the Commons-category **sitelink** (`Scommonswiki "Category:<taxon>"`, not P373) — in a panel on the main view. **Done is confirm-gated:** picking records an intention, `Copy` no longer clears anything, and **Confirm pending** (or a row's **Confirm**) asks live Wikidata; a finding becomes `done` only when *both* statements are there, and otherwise stays open saying which half is missing. **Skip** is the escape hatch. Design/details in [docs/commons-upload.md](docs/commons-upload.md) and [docs/commons-upload-dev.md](docs/commons-upload-dev.md) (§7).

## Architecture

Seven entry scripts (six tools) plus the server, each wiring together shared modules; data flows in memory. Shared building blocks: the local iNat taxa SQLite index (`lib/getInatTaxaDb.js`) and the Wikidata SPARQL / CirrusSearch helpers (`lib/utils.js`).

**Source layout.** Entry scripts (`check*.js`, `draftCategory.js`) stay at the repository root — that's what `node checkImages.js …` / the `npm run …` scripts invoke. Everything else is grouped:

- **`lib/`** — core data + domain logic: `utils.js` (SPARQL/CirrusSearch/Commons helpers, arg parsing, IUCN maps), `cache.js`, `paths.js` (the `output/` + `cache/` path helpers), `getInatTaxaDb.js`, `getFromInat.js`, `getInatNames.js`, `generateWikitext.js` (Commons category wikitext + `fetchEntities`).
- **`report/`** — output rendering: the `generate*HTML.js` report builders and their shared `htmlShared.js` (base CSS, `renderReportPage`/`doneScript`, tree-pair + copy helpers).
- **`server/`** — the Fastify app (`npm run web`): `app.js` (`buildServer({store})`, which never listens and never closes the store it is handed — the same injection seam `verifyOpenFindings` uses), `routes/findings.js` (`GET /api/findings` plus the confirm/skip/uploads writes, encapsulated so its rate limiter covers the API and not the static assets), `routes/discover.js` + `jobs.js` + `discoverChild.js` (topping up the backlog, which runs in a **forked child** — an in-process run would block the event loop for ~1 s per taxa-index load and hold a ~650 MB spike), `index.js` (opens `data/findings.db`, binds **127.0.0.1 by default**, owns shutdown). Threat model and the reason behind every header in [docs/security.md](docs/security.md) — **read it before adding a write endpoint.**
- **`web/`** — the browser upload app (its own `web/js/*`, see below), served by `server/`.
- **`test/`** — `node:test` unit suite (`*.test.js`), run via `npm test`.
- **`output/`, `cache/`** — gitignored, auto-created generated artifacts (deliverables and cross-run caches respectively); see the Outputs/Caches bullets above.

All paths are relative to the working directory (the repo root, where the tools run), centralised in `lib/paths.js` — so deliverables land in `output/`, caches in `cache/`, and the findings database in `data/`.

| Tool | Entry | Finds | Docs |
|---|---|---|---|
| Image checker | `checkImages.js` | taxa with P3151 but no image (P18) | [docs/images.md](docs/images.md) |
| Verification | `verifyFindings.js` | open findings already fixed, merged or deleted upstream | [docs/images.md](docs/images.md#verification) |
| Vernacular names | `checkNames.js` | iNat common names missing from P1843 | [docs/names.md](docs/names.md) |
| iNat links | `checkLinks.js` | taxa with a name but no P3151, matched to iNat | [docs/links.md](docs/links.md) |
| iNat links stats | `checkLinksStats.js` | per-IUCN match/ambig breakdown (no HTML) | [docs/links.md](docs/links.md) |
| Area checker | `checkArea.js` | image-less taxa observed near a location | [docs/area.md](docs/area.md) |
| Category draft | `draftCategory.js` | Commons category draft for given taxon QID(s) | [docs/images.md](docs/images.md#generating-a-single-category-draft) |
| Upload app | `web/` + `server/` (`npm run web`) | assisted iNat→Commons photo upload (pre-filled form) | [docs/commons-upload.md](docs/commons-upload.md) |
| Server | `server/index.js` (`npm run web`) | serves `web/`, `GET /api/findings`, the confirm/skip/uploads writes, and `POST /api/discover` | [docs/security.md](docs/security.md) |
| Discovery | `lib/discover.js` (CLI: `checkImages.js`; app: `POST /api/discover`) | tops up the backlog, scoped by taxon/IUCN | [docs/dev.md](docs/dev.md#discovery-libdiscoverjs-serverjobsjs) |

The upload app is a build-step-free `web/` folder (plain HTML/JS/CSS), served by `server/` together with the findings API. It reads its worklist from `GET /api/findings` and calls the iNaturalist API directly from the browser. `web/js/commonsUpload.js` builds the pre-filled `Special:Upload` URL and file-page wikitext; `web/js/enrich.js` resolves the place hierarchy, taxon ancestry, and geographic/author categories (iNat + Commons + Wikidata Query Service, all CORS-open); `web/js/api.js` + `web/js/state.js` talk to this app's own backend and mirror the uploads/picks it holds; `web/js/cache.js` keeps only the enrichment lookup caches in `localStorage` (regenerable derived data) plus the legacy readers the one-time import uses. See [docs/commons-upload.md](docs/commons-upload.md) and [docs/commons-upload-dev.md](docs/commons-upload-dev.md).

Reusable, app-agnostic Commons/iNaturalist/Wikidata integration recipes (Special:Upload prefill, copy-upload allowlist, category-existence checks, `{{Taken on}}`, two-axis `<Taxon> of <Place>` + most-specific-location categories, Nominatim reverse geocoding, and author categories, P12022) are collected in [docs/commons-integration.md](docs/commons-integration.md) — the reference for building further Commons-upload tools.

**Work in progress:** the checkers are being restructured around a persistent findings database (replacing the `cache/cache-*.json` tombstones, which lose the backlog on every re-run) served by a Fastify backend. [`docs/findings-db-roadmap.md`](docs/findings-db-roadmap.md) is the plan of record — the ordered slices, the schema, and the decisions behind them. Slices 0–5 are done (findings DB, verification, Fastify, confirm-gated done state, on-demand discovery); 5b, 5c and 6–9 remain, and OAuth editing is deliberately outside the plan until the tool has been run by hand for a while. Read it before changing anything about caching, persistence, or the web app.

**Security:** [`docs/security.md`](docs/security.md) is the threat model for `server/` — what each header and limit is for, and what is deliberately *not* done (no auth, no TLS, loopback-only by default). Read it before exposing the server on a network, before adding any endpoint that writes, and before the OAuth work.

Module-wiring diagrams and implementation details live in [`docs/dev.md`](docs/dev.md) — read it on demand. Topics covered there:

- **Module wiring** — per-tool data-flow diagrams (which module calls what)
- **SQLite taxa index** — schema, `get()`/`getAll()`/`getAncestors()`/`allNames()`/`allInatIds()`/`descendantInatIds()`, stateofmatter filter (`lib/getInatTaxaDb.js`)
- **`node:sqlite` driver** — why there is no SQLite dependency and `engines` is `>=26`; the four `better-sqlite3` differences that bite (no `.pluck()`, no `db.transaction()`, `run(...row)` not `run(row)`, null-prototype rows)
- **zh-hans/zh-hant normalization** — why `zh-CN`/`zh-TW` are remapped (`lib/getInatNames.js`)
- **Ancestor traversal depth** — why the cap is `MAX_ANCESTOR_DEPTH` (40) rounds; reaching the kingdom for endemic categories (`lib/generateWikitext.js`)
- **Commons Taxonavigation templates** — wrappers, suffixed families, Fungorum, IUCN categories, placement rules (`lib/generateWikitext.js`)
- **Shared report rendering** — base CSS + page skeleton + done/hide-done script factored into `report/htmlShared.js` (`renderReportPage`, `doneScript`, `BASE_REPORT_CSS`, `TREE_PAIR_CSS`), reused by the four `generate*HTML.js` builders
- **SPARQL & CirrusSearch** — TSV format, why WDQS can't scan the big filtered sets, the query-by-value inversion (by name for links, by iNat ID for images) (`lib/utils.js`, `checkLinks.js`, `checkLinksStats.js`, `checkImages.js`)
- **Taxonomy tree comparison & `--auto` filter** — `compareAncestorTrees()`, Noctuidae/Erebidae disagreement (`lib/utils.js`, `checkLinks.js`)
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
