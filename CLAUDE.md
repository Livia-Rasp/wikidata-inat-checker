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
TOPUP_ENABLED=1 DISCOVER_ENABLED=1 npm run web   # …and a daily scheduled top-up (see threat-model.md)
npm test                                    # unit suite (node --test over test/*.test.js)
npm run test:coverage                       # …with the CI coverage floor enforced (a ratchet)
npm run lint                                # oxlint, correctness category only
npm run typecheck                           # tsc over jsconfig.json, then web/jsconfig.json
npm run screenshots                         # regenerate docs/screenshots/ (needs Chromium)
npm run record                              # re-record demo.gif (needs Chromium + ffmpeg)
npm run backup                              # snapshot data/findings.db, prune old ones (see container.md)

docker compose up --build                   # the server in a container — see docs/container.md
```

**Changing anything under `web/` means re-running `npm run screenshots`** and committing the
result with the change. The screenshots are documentation and go stale the same way prose does —
see [docs/screenshots/README.md](docs/screenshots/README.md).

## Versioning

**Every feature bumps `package.json` and says so in the commit subject: `vX.Y.Z: <what changed>`.**
Minor for a feature, patch for a fix. Intermediate work commits do not bump — a run of commits
sits at one version and a single `vX.Y.Z:` commit closes the batch.

There is no CHANGELOG, no git tag and no release tooling, on purpose: **`git log --grep '^v[0-9]'`
is the changelog**, and it cannot drift from what was actually shipped. Same practice as
`commons-describe-upload-toolbox` — a sibling repo (another Commons-upload tool of Livia's),
cited elsewhere in `docs/` as precedent alongside another sibling repo, `vue-commons-gallery`.

The version has two consumers, so it is read and never copied: the User-Agent in `lib/utils.js`
(sent to Wikimedia and iNaturalist) and the container image tag pushed by CI.

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
| Area checker | `checkArea.js` | image-less taxa observed near a location; also a discovery scope in the app (`/area`) | [area.md](docs/area.md) |
| Category draft | `draftCategory.js` | Commons category draft for given taxon QID(s) | [images.md](docs/images.md#generating-a-single-category-draft) |
| Upload app | `web/` + `server/` | assisted iNat→Commons upload; the worklist, links, search and area pages | [commons-upload.md](docs/commons-upload.md) · [commons-upload-dev.md](docs/commons-upload-dev.md) |
| Server | `server/index.js` | serves `web/`, the findings API, the writes, search, discovery | [threat-model.md](docs/threat-model.md) |
| Container | `Dockerfile`, `compose.yaml` | the server in Docker; the published GHCR image | [container.md](docs/container.md) |

## Source layout

Entry scripts (`check*.js`, `draftCategory.js`) stay at the repository root — that is what the
`npm run …` scripts invoke — next to `Dockerfile`, `compose.yaml`, `.dockerignore` and
`renovate.json5`, which their tooling requires there. Everything else is grouped:

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
- **`tools/`** — repo maintenance, not product. `screenshots.mjs` regenerates the docs images and
  `record.mjs` the demo GIF; `cdp.mjs` holds what both need (CDP client, throwaway DB copy,
  server and browser startup). The recording's confirm step runs against live Wikidata and is
  chosen so it genuinely succeeds — see [docs/screenshots/README.md](docs/screenshots/README.md).

## Generated artifacts

All gitignored and created on first write; `lib/paths.js` centralises the paths. Two are
disposable, one is not:

- **`output/`** — the HTML/QS deliverables. Safe to delete; a re-run regenerates them.
- **`cache/`** — cross-run caches (`cache-commons-cats.json`). Safe to delete; re-runs then
  re-scan from scratch. Images, links and names keep no cache file — all three moved to
  `data/findings.db`.
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
  restructure around `data/findings.db`. Slices 0–8 and 10 are done; 9 remains, and OAuth is
  deliberately outside the plan. Two known gaps are written up there rather than fixed: a **CLI
  run killed outright stays `running`** (only the server reconciles), and the **scheduled top-up
  retries every interval rather than once a day** when the taxa index is missing (no run row is
  ever opened for that failure, so the daily-once gate can't see it). **Read it before changing
  anything about caching, persistence, or the web app.**
- [`docs/commons-integration.md`](docs/commons-integration.md) — app-agnostic Commons/iNat/
  Wikidata recipes, the reference for building further Commons-upload tools.
