# CLAUDE.md

Guidance for Claude Code (claude.ai/code) when working in this repository.

Project-level ToDos live in the Obsidian vault, not here — query them with `vault_tasks` /
`vault_overview` (`winged-eye-obsidian` MCP, read-only; never write to the vault).

Keep this file short. Details belong in `docs/`, linked from here.

## Commands

```sh
node checkImages.js --limit 500 --iucn VU   # image checker (--limit, --iucn optional)
node checkImages.js --taxon Orchidaceae     # scope to a clade; name or iNat ID
node checkImages.js --recheck-after 30      # re-examine negatives older than N days (default 90)
node verifyFindings.js                      # re-check the open backlog against live Wikidata
node checkNames.js --limit 500 --iucn CR    # vernacular names (--all includes taxa with some P1843)
node checkLinks.js --limit 200 --auto       # iNat links (--auto also writes output/links-auto.qs)
node checkLinksStats.js                     # per-IUCN match/ambig table, no HTML
node checkArea.js --lat 48.147 --lng 11.589 --radius 10   # area checker (all three required)
node draftCategory.js Q14625955             # Commons category draft for taxon QID(s)

# each has an npm script — images, verify, names, links, linkStats, area, draft.
# The -- is required so npm forwards the flags:
npm run images -- --limit 500 --iucn VU
npm run web                                 # Fastify: serves web/ + the API, localhost:8080
DISCOVER_ENABLED=1 npm run web              # …and allow discovery from the app (loopback only)
npm test                                    # unit suite (node --test over test/*.test.js)
```

No build step. Node 26+ (`node:sqlite` is built in, so there is no native dependency).
Server environment variables and why each exists: [docs/threat-model.md](docs/threat-model.md).

## Tools

| Tool | Entry | Finds | Docs |
|---|---|---|---|
| Image checker | `checkImages.js` | taxa with P3151 but no image (P18) | [images.md](docs/images.md) |
| Verification | `verifyFindings.js` | open findings already fixed, merged or deleted upstream | [images.md](docs/images.md#verification) |
| Vernacular names | `checkNames.js` | iNat common names missing from P1843 | [names.md](docs/names.md) |
| iNat links | `checkLinks.js` | taxa with a name but no P3151, matched to iNat | [links.md](docs/links.md) |
| iNat links stats | `checkLinksStats.js` | per-IUCN match/ambig breakdown (no HTML) | [links.md](docs/links.md) |
| Area checker | `checkArea.js` | image-less taxa observed near a location | [area.md](docs/area.md) |
| Category draft | `draftCategory.js` | Commons category draft for given taxon QID(s) | [images.md](docs/images.md#generating-a-single-category-draft) |
| Upload app | `web/` + `server/` | assisted iNat→Commons upload; the worklist | [commons-upload.md](docs/commons-upload.md) |
| Server | `server/index.js` | serves `web/`, the findings API, the writes, search, discovery | [threat-model.md](docs/threat-model.md) |

## Source layout

Entry scripts (`check*.js`, `draftCategory.js`) stay at the repository root — that is what the
`npm run …` scripts invoke. Everything else is grouped:

- **`lib/`** — data + domain logic: SPARQL/CirrusSearch/Commons helpers and arg parsing
  (`utils.js`), the findings store (`db.js`), the iNat taxa index (`getInatTaxaDb.js`),
  discovery (`discover.js`), verification (`verify.js`), confirmation (`confirm.js`), the
  backlog↔clade join (`backlogIndex.js`), Commons wikitext (`generateWikitext.js`).
- **`report/`** — the `generate*HTML.js` builders and their shared `htmlShared.js`.
- **`server/`** — the Fastify app: `app.js` (`buildServer({store})`, which never listens and
  never closes the store it is handed), `routes/` (findings, search, discover),
  `writeGuard.js`, `jobs.js` + `discoverChild.js` (discovery runs in a **forked child**),
  `index.js` (opens the DB, binds 127.0.0.1 by default, owns shutdown).
- **`web/`** — the browser upload app, plain HTML/JS/CSS, served by `server/`. Three pages:
  `index.html` (worklist), `taxon.html` (one taxon's photos), `search.html` (backlog search).
- **`test/`** — `node:test` unit suite. No network, sub-second. Add cases when touching the
  pure logic it covers.

## Generated artifacts

All gitignored and created on first write; `lib/paths.js` centralises the paths. Two are
disposable, one is not:

- **`output/`** — the HTML/QS deliverables. Safe to delete; a re-run regenerates them.
- **`cache/`** — cross-run caches (`cache-names.json`, `cache-links.json`,
  `cache-commons-cats.json`). Safe to delete; re-runs then re-scan from scratch.
- **`data/findings.db` — NOT safe to delete.** The accumulated backlog and everything worked
  through, which nothing can reconstruct. See [images.md](docs/images.md).

The ~236 MB iNat taxa index lives separately under `~/.cache/wikidata-inat-checker/`; it is
derived, dropped and rebuilt, so never confuse it with `data/`.

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

Rank/status QIDs and the `{{IUCN}}` logic: [dev.md](docs/dev.md#wikidata-qid-reference).

## Read before you change

- [`docs/dev.md`](docs/dev.md) — module wiring, the SQLite taxa index and the `node:sqlite`
  gotchas, the findings store, discovery, search, confirm-vs-verify, SPARQL/CirrusSearch
  patterns, Commons Taxonavigation rules. **Read on demand when debugging or extending.**
- [`docs/threat-model.md`](docs/threat-model.md) — the threat model for `server/`, every header, limit
  and environment variable, and what is deliberately not done. **Read it before adding any
  endpoint that writes or talks to an authenticated API.**
- [`docs/findings-db-roadmap.md`](docs/findings-db-roadmap.md) — the plan of record for the
  restructure around `data/findings.db`. Slices 0–5 and 5c are done; 5b and 6–9 remain, and
  OAuth is deliberately outside the plan. Two known gaps are written up there rather than
  fixed: **`skipped` is global**, and the **ambiguous-match views** need a real interface.
  **Read it before changing anything about caching, persistence, or the web app.**
- [`docs/commons-integration.md`](docs/commons-integration.md) — app-agnostic Commons/iNat/
  Wikidata recipes, the reference for building further Commons-upload tools.
