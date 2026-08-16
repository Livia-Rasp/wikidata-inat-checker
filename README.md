# wikidata-inat-checker

A set of tools for improving Wikidata taxon items using iNaturalist data — finding missing images, missing vernacular names, and missing iNaturalist taxon links, and generating the Wikitext or QuickStatements needed to fill them in.

## Installation

Requires Node.js 26+ — the SQLite index uses the built-in `node:sqlite` module, so there is no native build step. A `.nvmrc` pins the version (`nvm use`).

```sh
git clone https://github.com/Livia-Rasp/wikidata-inat-checker.git
cd wikidata-inat-checker
npm install
```

## Tools

| Tool | Command | Output | Documentation |
|---|---|---|---|
| Image checker | `npm run images` | `output/drafts.html` | [docs/images.md](docs/images.md) |
| Verification | `npm run verify` | prunes the backlog, re-renders reports | [docs/images.md](docs/images.md#verification) |
| Vernacular names | `npm run names` | `output/names.html` | [docs/names.md](docs/names.md) |
| iNat links | `npm run links` | `output/links.html`, `output/links-ambiguous.html` | [docs/links.md](docs/links.md) |
| Area checker | `npm run area -- --lat <lat> --lng <lng> --radius <km>` | `output/area.html` | [docs/area.md](docs/area.md) |
| Category draft | `npm run draft -- <QID> [<QID> …]` | draft printed to stdout | [docs/images.md](docs/images.md#generating-a-single-category-draft) |
| Upload app | `npm run web` | `web/` app + findings API at localhost:8080 | [docs/commons-upload.md](docs/commons-upload.md), [docs/security.md](docs/security.md) |

Every tool writes its reports into `output/` and its cross-run caches into `cache/`; the image checker also keeps a **findings database** at `data/findings.db`. All three are gitignored and created on first run. Clearing `output/` is safe — reports regenerate; the `cache/` files let re-runs skip already-checked taxa. **`data/` is not safe to clear**: it holds the accumulated backlog and what has been worked through, which nothing can reconstruct.

That database is why the image checker's report *grows* across runs instead of being replaced — every outcome is recorded, so re-running with a new filter adds to `output/drafts.html` rather than overwriting it. `npm run verify` is the other half: it re-checks the open backlog against live Wikidata and drops anything someone else has already fixed, or whose item has been merged or deleted. See [docs/images.md](docs/images.md) and, for where this is heading, [docs/findings-db-roadmap.md](docs/findings-db-roadmap.md).

The image, names, and links checkers accept `--limit <n>` and `--iucn <code>` (e.g. `CR`, `EN`, `VU`) flags; the area checker takes `--lat`/`--lng`/`--radius` instead. The `--` after `npm run <tool>` is required so npm forwards the flags to the script.

```sh
npm run images -- --limit 500 --iucn CR   # 500 Critically Endangered taxa
npm run images -- --taxon Orchidaceae     # scope the image checker to one clade (orchids)
npm run links -- --limit 1000 --iucn EN   # 1000 Endangered taxa
```

The image checker also accepts `--taxon <name|id>` to restrict the scan to a single clade (the taxon plus all its iNat descendants); it accepts a scientific name or a numeric iNat ID and composes with `--iucn`/`--limit`. Its `--recheck-after <days>` (default 90) controls how long a taxon recorded as having no CC photos is trusted before being re-examined — photos keep being uploaded, so those results expire; `0` re-checks all of them.

## iNaturalist → Commons upload app

Run the image checker at least once so the findings database has a backlog. Then:

```sh
npm run web        # serve the web/ app at http://localhost:8080
```

That command starts a small [Fastify](https://fastify.dev) server (`server/`) which serves the app
and the findings API over the same database the checkers write. It binds `127.0.0.1` by
default — exposing it on a network is a deliberate act (`HOST=…`), and the threat model, the headers
and what is deliberately *not* done are in [docs/security.md](docs/security.md). Other environment
variables: `PORT`, `FINDINGS_DB`, `LOG_LEVEL`, `RATE_LIMIT_MAX`, `RATE_LIMIT_WINDOW`, `TRUST_PROXY`.

Start it with `DISCOVER_ENABLED=1` and the app gains a **Find more taxa** control that runs a scoped
discovery without a terminal — the same work `npm run images` does, in a forked child, with progress
you can watch and a cancel that keeps whatever it already found. It is off by default and refused
from anything but a local connection, because a run spends *your* Wikidata and iNaturalist API
budget for minutes at a time.

The app lists the image-less taxa, and for each one shows its research-grade,
Commons-compatibly-licensed iNaturalist photos. Selecting a photo opens the Wikimedia
Commons upload form **pre-filled** with the file URL, license, filename, and a detailed
description — you review and submit it yourself (nothing is uploaded automatically).

The generated file description aims to be comprehensive but not overloaded:

- an `{{en|<English common name> (''Scientific name'') in County, State, Country}}`
  description, taken from the observation's identified taxon and its location;
- a `{{Taken on|<date>|location=<Country>}}` date (so the file is categorised by date and
  country);
- **geographic categories** along two axes, when they exist on Commons: a taxon-in-place
  category (e.g. `Picidae of Texas`) and the most-specific *location* category (e.g.
  `Grayson County, Texas`, or a town when one exists) — the photo's coordinates are
  reverse-geocoded (OpenStreetMap Nominatim) to reach the county/municipality level, and a
  category nested inside the other is dropped so there's no redundancy;
- an **author category** when the photographer has one (discovered via Commons'
  `{{Inaturalist user}}` template and Wikidata's iNaturalist-user-ID property).

A **Mark as uploaded** checkbox on each photo records what you've uploaded — in the findings
database, so it survives a cleared browser profile; the main page's **Download uploaded list**
button exports that list as JSON. All the category/location lookups are cached in your browser
so repeats are fast.

Picking **Use as Wikidata image (P18)** on the uploaded photo queues the two remaining
Wikidata edits — the image (P18) and the Commons-category sitelink — into a
**QuickStatements** panel on the main page, so you can apply them to many items in one batch.

Nothing is marked done because you said so. Copy the batch, run it in QuickStatements, then
press **Confirm pending** (or a single row's **Confirm**): the server checks live Wikidata and
marks the taxon done **only if both statements are actually there**. If only half the batch
applied, the row stays on the worklist and tells you which half is missing. **Skip** is for a
taxon you never want offered again.

See [docs/commons-upload.md](docs/commons-upload.md) and [web/README.md](web/README.md).

## Project structure

- **Entry scripts** (`check*.js`, `draftCategory.js`) live at the repository root — these are what the `npm run …` commands invoke.
- **`lib/`** — shared core and domain logic (Wikidata/Commons/iNat helpers, the local SQLite taxa index, Commons wikitext generation, and `paths.js` for the output/cache locations).
- **`report/`** — the HTML report builders, sharing a common page skeleton in `report/htmlShared.js`.
- **`server/`** — the Fastify app behind `npm run web`: serves `web/`, the findings API, the confirm/skip writes, and (opt-in, local only) discovery ([docs/security.md](docs/security.md)).
- **`web/`** — the browser upload app (plain HTML/JS/CSS, no build step).
- **`test/`** — unit tests (`npm test`, using Node's built-in test runner — no dev dependencies).
- **`output/`, `cache/`** — generated reports and cross-run caches (gitignored, created on first run).

Run the tests with `npm test`; they're fast and hit no network.

Architecture and module-wiring details are in [docs/dev.md](docs/dev.md).

## License

MIT — see [LICENSE](LICENSE).
