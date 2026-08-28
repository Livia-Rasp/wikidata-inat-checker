# Developer notes

The implementation reference: how the modules fit together, and why the non-obvious decisions are what they are. Written to be read on demand when debugging or extending a tool, not front to back — the section headings name the module each part belongs to.

Its companion is [threat-model.md](threat-model.md) — the threat model for `server/`, why each header, limit and validation rule is there, and what is deliberately not done. Anything touching the HTTP surface belongs in that document, not this one.

## Module wiring

Each entry script wires shared modules together; all data flows in memory.

Source is grouped by role: entry scripts (`check*.js`, `draftCategory.js`) sit at the repository root; shared core/domain logic is in **`lib/`** (`utils`, `getInatTaxaDb`, `getFromInat`, `getInatNames`, `generateWikitext`); output rendering is in **`report/`** (the `generate*HTML` builders and their shared `htmlShared`); the HTTP layer is in **`server/`**. The diagrams reference modules by their real paths; method-call notation like `utils.foo()` / `getInatTaxaDb.bar()` refers to `lib/utils` / `lib/getInatTaxaDb`.

### Image checker (`checkImages.js`)
```
checkImages.js
  └─ lib/getInatTaxaDb.js {allInatIds()}: all iNat taxon IDs (drives the Wikidata query)
       → shuffled (utils.shuffle(), seeded via --seed) before the --limit cutoff, so an
         unscoped/non-IUCN run doesn't always hit the same early slice of allInatIds()' order
  └─ utils.fetchWdTaxaByInatIds() → Wikidata: query BY iNat ID in VALUES POST batches
       → taxa with P3151 = a local iNat ID but no P18 (IUCN via OPTIONAL, JS-filtered)
       → --limit caps collected candidates; cached ids skipped to reach new taxa
  └─ lib/db.js {skipQids()}: qids already settled, or negative but still inside --recheck-after
  └─ lib/getFromInat.js: iNat /v1/observations/species_counts → { available, inatTaxonIds, failed }
  └─ lib/generateWikitext.js: Wikidata wbgetentities ancestor traversal → { [wdUri]: wikitext }
  └─ lib/db.js {upsertTaxon(), recordFinding()}: every outcome persisted to data/findings.db
       → open | no_draft | no_photos; a failed iNat batch records nothing so it retries
  └─ lib/db.js {openFindings()}: the WHOLE open backlog, not just this run
       └─ report/generateHTML.js: writes output/drafts.html
       (the web app needs no export — server/ reads the same database live)
```

### Vernacular names checker (`checkNames.js`, `lib/discoverNames.js`)

Migrated onto the findings database in slice 8, the same shape `checkLinks.js`/
`lib/discoverLinks.js` took in slice 7: `checkNames.js` is argument parsing and report rendering;
`discoverNames({store, taxaDb, scope, limit, seed, showAll, onProgress, signal})` is the work, and
the server runs the identical function for on-demand and scheduled discovery. It is a **sibling**
to `lib/discover.js`/`lib/discoverLinks.js`, not a generalisation of either — unlike links, there is
no "which iNat taxon" ambiguity to classify (every candidate already carries a confirmed `inatId`
from a P3151-linked WD item), so recording happens in one pass after the batched Wikidata + iNat
fetches, the same shape `discoverLinks.js` uses rather than `discover.js`'s per-batch recording
(which exists only because images' per-taxon photo lookups are expensive and worth interrupting
mid-run). `server/discoverChild.js` dispatches by `config.tool` (`'images'` default, `'links'`,
`'names'`).

```
discoverNames()
  └─ lib/getInatTaxaDb.js {allInatIds()}: all iNat taxon IDs (drives the Wikidata query)
       → shuffled (utils.shuffle(), seeded via --seed) before the --limit cutoff, same reason
         as the image and links checkers
  └─ utils.fetchWdTaxaLinkedByInatIds() → Wikidata: query BY iNat ID in VALUES POST batches
       → taxa with P3151 = a local iNat ID, no absence filter (P1843 is filtered downstream,
         not at query time — --all decides whether taxa with *some* P1843 are still shown)
       → with --iucn: utils.fetchWdNamesByIucn() runs one direct P141-filtered query instead
       → deduped by qid (taxa/findings/skipQids() are qid-keyed throughout), not inatId — a
         deliberate change from the pre-migration checkNames.js's inatId-keyed dedupe
       → lib/db.js {skipQids('name', ...)}: qids already settled, or negative but still inside
         --recheck-after — the direct replacement for the old cache-names.json tombstone
  └─ lib/generateWikitext.js (fetchEntities): Wikidata P225 + P1843 per candidate, one batch
  └─ lib/getInatNames.js: iNat /v1/taxa?all_names=true → names per taxon
  └─ diff: iNat names absent from Wikidata P1843 (case-insensitive; scientific name and bare
       genus excluded — see "Genus-as-vernacular leak" below)
  └─ lib/db.js {upsertTaxon(), recordFinding()}: every taxon with ≥1 missing name persisted to
       data/findings.db, kind='name', payload {missing: [{locale, name}, ...]}
  └─ lib/db.js {listFindings({kind:'name', status:'open'})}: the WHOLE open backlog, not just
       this run — its row shape already matches generateNamesHTML's NameItem type exactly
       └─ report/generateNamesHTML.js: writes output/names.html (QuickStatements + aggregate field)
       (the web app needs no export — server/ reads the same database live)
```

### iNat links checker (`checkLinks.js`, `lib/discoverLinks.js`)

Migrated onto the findings database in slice 7, the same shape `checkImages.js`/`lib/discover.js`
took in slice 1: `checkLinks.js` is argument parsing and report rendering; `discoverLinks({store,
taxaDb, scope, limit, seed, ambiguousOnly, onProgress, signal})` is the work, and the server runs
the identical function for on-demand and scheduled discovery. It is a **sibling** to
`lib/discover.js`, not a generalisation of it — the two pipelines diverge past run bookkeeping
(images batches iNat photo lookups and builds wikitext drafts; links does a SPARQL P3151
cross-check, a P13177 homonym filter, and an ancestor-chain comparison), so `server/discoverChild.js`
dispatches between them by `config.tool` (`'images'` default, `'links'`, `'names'`) rather than any
one function trying to serve every shape.

```
discoverLinks()
  └─ lib/getInatTaxaDb.js: SQLite taxa index (~236 MB, built from iNat open-data S3 dump)
       → get(name) → {inatId, rank} | undefined   (undefined = not found or homonym)
       → getAll(name) → [{inatId, rank}]           (all active taxa sharing the name)
       → allNames() → all distinct iNat names       (drives the Wikidata query)
       → shuffled (utils.shuffle(), seeded via --seed) before the --limit cutoff — see docs/links.md
  └─ utils.fetchWdTaxaByNames() → Wikidata: query BY iNat name in VALUES POST batches
       → taxa with P225 = an iNat name but no P3151 (IUCN via OPTIONAL, JS-filtered)
       → with --iucn: utils.fetchWdLinksByIucn() runs one direct P141-filtered query instead
       → --limit caps collected candidates (real matches), not raw taxa scanned
  └─ Classification: no local match → no_match; get() undefined + getAll() 2+ → ambiguous;
       get() found → a single-match candidate, cross-checked next (skipped under --ambiguous-only)
  └─ SPARQL → Wikidata: found iNat IDs already on other items → open (unclaimed) | conflict (claimed)
  └─ SPARQL → Wikidata: P13177 (homonymous taxon) to filter false conflicts out of `conflict`
  └─ getInatTaxaDb.getAncestors(inatId): iNat ancestor chain from SQLite (no API call)
  └─ utils.fetchWdAncestorChains() (wdt:P171+, batches of 100, 2 concurrent): Wikidata ancestor chain
  └─ utils.compareAncestorTrees(): rank-by-rank {matches, mismatches, matchedRanks} — the `evidence`
       stored on every open/ambiguous/conflict finding, and isAutoEligible() over it decides
       `open`'s `autoEligible` (the --auto bar: 0 mismatches, ≥3 matches, family or order present)
  └─ lib/db.js {upsertTaxon(), recordFinding()}: every outcome persisted to data/findings.db, kind='link'
       → open | ambiguous | conflict | no_match — see docs/links.md#statuses
  └─ report/generateLinksHTML.js / generateAmbiguousHTML.js: render from the DB backlog
       (open+conflict findings, and ambiguous findings, respectively — not this run's in-memory
       results), re-fetching ancestor chains for display since the payload stores compareAncestorTrees'
       summary, not the full chains, for `open` findings — `ambiguous`/`conflict` findings keep the
       full chains on the payload instead, for the app's review UI to render without an extra fetch
```

**`output/links-ambiguous.html`'s exact row markup is a cross-repo contract**, not just a report
shape: the sibling `xgboost-inat-wikidata-match` repo's `build_gold_labeling_kit.py` scrapes it
with BeautifulSoup (`id="row-{qid}"`, `td.wd-col`, `td.taxon-col`, `class="candidate-row"`) to
build its gold-labelling sample. Changing that markup without checking that script still parses it
would silently break another project's reproducibility — see
[links.md#beyond-this-checker-a-confidence-model](links.md#beyond-this-checker-a-confidence-model).

**Picking an ambiguous candidate (`lib/pick.js`).** `pickCandidate(store, id, inatId)` is how a
human resolves an `ambiguous` finding in the app (`POST /findings/:id/pick`) — purely local, no
Wikidata call, which is why it is its own file rather than folded into `confirm.js`. It re-records
the finding as `open` via `recordFinding()`, not `markVerified()` (this is a fresh candidacy with a
real payload, not a "still true" observation), and it must also call `upsertTaxon()` to write the
picked `inatId`/`rank` onto the `taxa` row — ambiguous discovery never had a single id to write
there, so without this the worklist row and its QuickStatements line kept reading the still-null
`taxa.inat_id`. Found only by clicking through the review UI live; no unit test caught it, since
every test asserted on the finding's payload, never on the taxa row a confirm/QS line actually reads.

### iNat links stats (`checkLinksStats.js`)
```
checkLinksStats.js
  └─ lib/getInatTaxaDb.js {allNames(), get(), getAll()}: name universe + classification
  └─ utils.cirrusCount() → CirrusSearch: exact total per IUCN bucket (instant)
  └─ utils.fetchWdTaxaByNames() → Wikidata: match/ambig via name-keyed VALUES POST batches
  └─ console table (No match = total − match − ambig)
```

### Area checker (`checkArea.js`)
```
checkArea.js (args: --lat --lng --radius)
  └─ iNat /v1/observations/species_counts (paginated, location-filtered, research-grade)
       → [{taxonId, taxonName, commonName, count}]
  └─ SPARQL VALUES → Wikidata: P3151 lookup + FILTER NOT EXISTS P18
       → Map<inatId, {wdUri, wdName}>            (items with no image)
  └─ iNat /v1/observations (batched 20 taxa/call, ordered by votes): up to 3 sample photos each
  └─ report/generateAreaHTML.js: writes output/area.html
```

## Output, cache and data locations (`lib/paths.js`)

All generated files go under three gitignored, auto-created top-level dirs, so nothing generated sits in the repo root. `lib/paths.js` centralises this: `outputPath(name)` → `output/<name>` (deliverables), `cachePath(name)` → `cache/<name>` (cross-run caches), `dataPath(name)` → `data/<name>` (the findings database), and `ensureParentDir(file)` `mkdir -p`s the parent right before a write (called by every writer — the generators and `lib/utils.js`'s `saveCommonsCatCache`).

- **`output/`** — `drafts.html`, `names.html`, `links.html`, `links-ambiguous.html`, `links-auto.qs`, `inat-links-conflicts.json`, `area.html`. Report builders default their `outputFile` param to `outputPath(...)`, so a caller can still redirect a single report elsewhere.
- **`cache/`** — `cache-commons-cats.json` (Commons category existence) only. The image, links and names checkers all keep no cache file of their own any more: images moved to `data/findings.db` in slice 1, links in slice 7 (its `cache-links.json` tombstone is gone — `skipQids('link', ...)` is the replacement), names in slice 8 (`cache-names.json` likewise gone, replaced by `skipQids('name', ...)`). Kept out of `output/` on purpose: clearing reports mustn't blow away the caches, or every re-run re-scans from scratch.
- **`data/`** — `findings.db` only, and unlike the other two it is **not safe to delete**: it is the accumulated backlog and the record of what has been worked through, and nothing can reconstruct it. See [Findings database](#findings-database-libdbjs) below. `findingsDbPath()` is the single definition of where it lives, honouring `FINDINGS_DB` for every process that opens it — the checkers as well as the server, which is what lets a container mount the volume elsewhere and a test run point somewhere disposable.

One thing deliberately lives elsewhere: the ~236 MB iNat taxa SQLite index (`~/.cache/wikidata-inat-checker/`, managed by `lib/getInatTaxaDb.js`). **Only the CLI may build it** — `ensureTaxaDb()` downloads ~189 MB and rebuilds; `openTaxaDb()` is the server's counterpart and throws instead.

## Tests (`test/`, `npm test`)

`node --test` runs `test/*.test.js` — a dependency-free unit suite for the pure logic, no network, sub-second. Coverage: arg parsing (`parseArgs` incl. `--key=value`, `parseLimit`, `parseIucnArg`), `chunk`/`qidFromUri`/`escapeHtml`, `compareAncestorTrees`, the IUCN code↔QID inverse, the taxa-index queries (`descendantInatIds`/`getAncestors`/`get`), and the report scaffold (`extractTaxonName`, `doneScript` key namespacing, `renderReportPage`). Add cases here when you touch that logic.

The taxa-index tests don't download the 189 MB dump: `lib/getInatTaxaDb.js` exports `createTaxaAccessor(db)` (the query layer split out from the loaders), so a test builds an in-memory `node:sqlite` DB with a handful of fixture rows and exercises the real queries against it. The `descendantInatIds` test deliberately models the Panthera case (species as direct children of a genus) — it fails against the old two-`LIKE` query, guarding that regression.

## Coding style checks (`npm run lint`, `npm run typecheck`)

Both are CI-gating (`.github/workflows/ci.yml`, ahead of `test:coverage`). No Prettier: a prior
trial in a sibling repo (Random Access, another of Livia's projects) rewrote 44 of 81 files for
557 changed lines and caught zero defects, so it was never adopted here either.

**Typecheck: `checkJs` over JSDoc, not a TypeScript source migration.** `jsconfig.json` had
`checkJs: true` since early on but no `typescript` devDependency to actually run `tsc` — so it was
inert, read only by an editor's language service, until both were added together. Two programs,
not one:

- `jsconfig.json` (root) — `lib/`, `report/`, `server/`, `test/`, the root entry scripts. Node ESM,
  no `lib` override needed.
- `web/jsconfig.json` — `web/js/*.js` only, `lib: ["ES2022", "DOM", "DOM.Iterable"]`.

The split exists because `@types/node` now ships global `fetch`/`Response`/`Headers`/etc.
(bundled `undici` types), and the DOM lib declares the same names — one program covering both
trees risks duplicate-identity friction, and can't cleanly express "this half wants DOM, the other
must not silently gain `window`/`document` as ambient names it shouldn't have." Two small
`jsconfig.json`-shaped files also matches how an editor already resolves config per file (nearest
wins), so editor and CI behaviour agree. `web/vendor/` (the vendored Leaflet copy) is excluded from
both — third-party code, not ours to check. `web/js/global.d.ts` declares the vendored Leaflet
global `L` (loaded via a classic `<script>` tag in `area.html`, consumed without import) as `any`
— deliberate, not worth a real `@types/leaflet` dependency for one bare global.

`tsc` does not auto-discover `jsconfig.json` the way an editor does — only `tsconfig.json` is
auto-discovered — so both npm scripts pass `-p` explicitly: `tsc -p jsconfig.json && tsc -p
web/jsconfig.json`.

The first real run (turning on a tool that had never actually been exercised before) surfaced 128
errors at the then-current, unchanged scope, none of them speculative — every one was either a
missing `typeof` in a `ReturnType<import(...).fn>` JSDoc pattern, `node:sqlite`'s `SQLOutputValue`
union needing a `String()`/null-guard at the row-mapping boundary (the schema is `STRICT` `TEXT`
columns, so the cast is safe), a SPARQL result row typed as bare `object` instead of the real
shape (`sparqlTSV`/`sparqlPost` flatten to `{[var]: string}`; `sparql()`'s raw JSON bindings are
`{[var]: {value: string}}` — genuinely different shapes, documented in `lib/utils.js`'s own
`SparqlBindingRow` typedef), a plain array literal `[a, b]` read as a union array rather than a
2-tuple (checkJs doesn't infer tuples from literals — needs an explicit `@type {[A, B][]}`), or a
DOM element access needing a cast from the generic `Element`/`HTMLElement`/`EventTarget` down to
the specific subtype actually in use (`.value` → `HTMLInputElement`, `.checked` → same,
`.disabled` → `HTMLButtonElement`, delegated click handlers' `e.target` → `HTMLElement` before
`.closest()`). A handful were genuine bugs the type checker was right to catch, not just
annotation gaps: `resolveAreaScope()` would silently accept a mistyped `--lat` with no value
(`parseArgs` gives a bare flag the value `true`, and `Number(true)` is `1` — a wrong-but-plausible
latitude) instead of raising `invalid_area_scope`; `buildServer`'s own options typedef undersold
what it actually accepted (missing `allowedHosts`/`rateLimit`, a `topupConfig` looser than what it
handed to `createScheduledTopup`); `p18Picks()`'s declared return type omitted the `findingId`
field it actually returns. None of this was fixed by loosening types to make errors go away —
where a shape was genuinely dynamic (`DiscoveryError`'s per-code `details`, a job runner's
`counts`, a status-poll blob), it became `Record<string, any>` or a small named typedef, not `any`
wholesale.

**Lint: `oxlint`, `categories.correctness` only** (`.oxlintrc.json`). No `env`/`globals`/
`overrides` block, on purpose — configured empirically after running it unscoped across the whole
tree (Node and browser code alike) and looking at what actually fired, not speculatively. It found
zero browser-global noise: `correctness` has no undefined-global-style rule, since that class of
check is `tsc`'s job here and `web/jsconfig.json` already covers it. Findings were real (an unused
catch parameter, a stray leftover test variable, an unused destructure, a regex simplified to
`String#startsWith`, a ternary used purely for side effects rewritten as `if`/`else`) except one:
`sparql()`'s control-character strip is deliberate (Wikidata does return literal C0 control
characters in string values, per the comment above it), so that one line carries an inline
`oxlint-disable-next-line` with a reason instead of being rewritten.

**Renovate needs no changes for either.** `renovate.json5`'s `packageRule #2`
(`matchManagers: ['npm', 'github-actions']`, `matchUpdateTypes` including minor/patch,
`matchCurrentVersion: '!/^0/'`, `groupName: 'all non-major dependencies'`, `automerge: true`)
already covers any new ≥1.0 devDependency generically — `typescript`, `@types/node` and `oxlint`
are all well past 1.0, so no packageRule needed to name them individually. Automerge is gated on
green CI regardless, so a future `oxlint` minor that adds a new `correctness` rule (its documented
semver policy: minor releases *can* surface new lint errors — that's expected, not a bug) simply
fails to automerge rather than silently breaking `main`.

## Report page rendering (`report/htmlShared.js`)

The four review reports (`generateHTML` = drafts, `generateLinksHTML`, `generateNamesHTML`, `generateAmbiguousHTML`) share a page shape: a heading, a "Hide done" control, one copyable `<pre>` per row, and per-row done/hidden state persisted in `localStorage`. That common shell lives in `report/htmlShared.js`, so each builder only supplies its own columns and any page-specific CSS:

- `BASE_REPORT_CSS` / `TREE_PAIR_CSS` — the shared style rules (the tree-pair columns are used only by the links + ambiguous reports). Copyable blocks are styled under both `.qs` (QuickStatements) and `.draft` (Wikitext) so a page just picks the class its rows use.
- `renderReportPage({ title, heading, intro, css, thead, rows, script, aggregate?, trailing? })` — assembles the full document, injecting the shared `COPY_SCRIPT` plus the page script.
- `doneScript({ segment, aggregate })` — the standard done/hide-done client logic, with an optional "copy all selected" aggregate panel (links + names). `segment` namespaces the `localStorage` keys per report (`''` → `done-<qid>`/`hide-done`; `'links'` → `done-links-<qid>`/`hide-done-links`; etc.) so each report remembers its own state.

The ambiguous report keeps its own script (it hides rowspan-grouped candidate rows, which the standard `doneScript` doesn't model) but still uses `renderReportPage` + the shared CSS. `generateAreaHTML` is a different shape (sortable, no copy/done state) and does **not** use these helpers.

Note that these reports still keep their done state in `localStorage`, per `segment`. The web app no longer does — its done state is confirm-gated in the database (see below) — so **a taxon ticked in `drafts.html` is not done as far as anything else is concerned.** Migrating the reports is not planned; they are a fallback view, and the app is the worklist.

## iNat taxa SQLite index (`lib/getInatTaxaDb.js`)

The local SQLite DB at `~/.cache/wikidata-inat-checker/taxa.db` has schema `taxa(taxon_id PK, name, rank, ancestry)` with an index on `name`. `get(name)` issues a `LIMIT 2` query: exactly one row → returns `{inatId, rank}`, two or more rows → returns `undefined` (homonym, treated the same as not-found). `getAll(name)` returns all matching rows and is used to surface the ambiguous cases. `getAncestors(taxonId)` parses the slash-separated `ancestry` field (ancestor IDs root-to-parent) and looks each up by primary key — no API call needed; filters out the `stateofmatter` root concept. `descendantInatIds(taxonId)` (drives `--taxon` scoping) returns every taxon whose `ancestry` contains the id as a whole path component, matching all four positions it can occupy — the entire string, the start (`<id>/…`), the end (`…/<id>`, a *direct* child), or the middle (`…/<id>/…`); the end position matters because `ancestry` omits self, so a taxon's direct children (e.g. a genus's own species) carry the id as the final component.

### Driver: `node:sqlite`, not `better-sqlite3`

SQLite comes from Node's built-in `node:sqlite` (`DatabaseSync`), so the project has **no native build step** — which is why the `engines` floor is `>=26`, where the module is fully stable. Four differences from `better-sqlite3` bit during the migration and will bite again:

- **No `.pluck()`.** Single-column reads use `.all().map(r => r.col)` instead. (`setReturnArrays()` exists as an alternative but reads worse.)
- **No `db.transaction()` helper.** Bulk inserts wrap `db.exec('BEGIN')` / `COMMIT` by hand, with `ROLLBACK` in a catch. This is not optional: without it the ~1.4 M-row index build commits per row and crawls.
- **`run()` binds positionally and rejects a single array argument** — `run(...row)`, never `run(row)`, which fails with `Unknown named parameter '0'`.
- **Rows come back with a null prototype.** `getAncestors` copies them into plain objects so callers get what the typedef promises; `assert.deepStrictEqual` against object literals fails otherwise.

The open option is `{ readOnly: true }` (camelCase), not better-sqlite3's `readonly` — a silent no-op if mistyped, though it does correctly reject writes when spelled right.

## Findings database (`lib/db.js`)

`data/findings.db` is the image checker's persistent worklist, replacing `cache/cache-images.json`. That file was a tombstone — it recorded *that* a taxon was checked, never what was found, while the results lived in files overwritten on every run, so a second run destroyed the first run's backlog. Here nothing is evicted: one row per `(qid, kind)`, and the reports render `openFindings()` — the accumulated backlog — rather than the current run.

Schema v1 is `taxa` / `findings` / `runs`, all `STRICT`, with the version in `PRAGMA user_version` and migrations applied one per transaction by `migrate()`. `createFindingsStore(db)` is split from `openFindingsDb(file)` for the same reason `createTaxaAccessor` is split from `ensureTaxaDb`/`openTaxaDb` — so tests can pass an in-memory database.

**Reading it: `listFindings({kind, status, limit, offset})`**, with `openFindings(kind)` as its unlimited `status: 'open'` case. Two details are load-bearing:

- **The default limit is "no limit" (`LIMIT -1`).** `drafts.html` renders the whole backlog off `openFindings()`, so a page size defaulted in the store would silently drop rows from it — a data-loss bug that looks like a display bug. HTTP callers cap it themselves, in their route schema.
- **The tiebreak is `f.id`, not `f.qid`.** `qid` is TEXT, so `Q9` sorts after `Q10`, and `discovered_at` ties are the norm within one batch — paging over that ordering would repeat and skip rows.

Rows carry `id` and `status` alongside the render fields, because the HTTP API addresses a finding by its id.

**Two processes, one file.** Since the server reads the database while a checker writes it, `openFindingsDb` sets `busy_timeout` **before** `journal_mode = WAL` — the WAL switch itself takes a brief exclusive lock, and with no timeout in effect it fails outright with `SQLITE_BUSY` when another process is mid-write. For the same reason `migrate()` uses `BEGIN IMMEDIATE` and re-reads `user_version` *inside* the transaction: with a deferred `BEGIN` and the version read outside, two processes opening the same fresh database both see 0, both begin, and the loser dies on `table taxa already exists`.

**Schema v2 adds `uploads`** — what has been uploaded to Commons, and which photo is a taxon's pending P18 pick. Both lived in `localStorage`, where no checker could see them and a cleared browser profile destroyed them; the pick was worse than that, being deleted the moment the QuickStatements were copied, so nothing recorded which file an edit was supposed to use. `dest_file` is the natural key (it is what the app computes for a photo and what Commons is asked to name the file), `qid` is nullable so an imported filename that does not parse back to a taxon is still kept, and a **partial unique index** (`ON uploads(qid) WHERE is_p18 = 1`) makes "at most one pick per taxon" a database guarantee rather than a convention. Nothing in this table is verified against Commons — the app only pre-fills the upload form, so every row is the user's own claim.

**Statuses.** `open` (photos + a draft), `no_draft` (photos but no P225 or no family template — still fixable by hand, and previously discarded silently), `no_photos`, plus `done` / `skipped` / `fixed_upstream` / `gone`, shared across kinds. **`kind='link'` (slice 7) adds `ambiguous` and `conflict`** — see [docs/links.md#statuses](links.md#statuses) — both listed in `STICKY_STATUSES` alongside `open`/`done`/`skipped`, and `no_match` (link's negative-with-shelf-life status) in `NEGATIVE_STATUSES` alongside `no_photos`/`no_draft`. Both lists are shared across every kind, not per-kind constants — a status added for one kind is a status the whole schema now recognises, which is what `GET /api/findings?status=` validates against.

**Negative results expire, settled ones do not.** `no_photos` / `no_draft` / `no_match` carry `checked_at` and stop being trusted after `--recheck-after` days (default 90, `0` = recheck all), because CC-licensed photos keep being uploaded, missing P225s keep being filled in, and taxa keep being added to iNat. `skipQids()` encodes this: everything sticky always skipped, negatives skipped only while fresh. **The trap:** skipping only `open` would resurface every taxon deliberately passed over on the next top-up — `test/db.test.js` guards it, including the link-only statuses (added after `GET /api/findings?status=ambiguous` 400'd in practice, the day `STICKY_STATUSES`/`NEGATIVE_STATUSES` were extended but not before — a gap that existed for several commits before it surfaced).

This is not a background sweep. There is no scheduler; expired rows simply become candidates again the next time discovery runs, under the same `--limit`.

### The server (`server/`)

`npm run web` runs `server/index.js`: it opens `data/findings.db`, hands the store to
`buildServer({store})` in `server/app.js`, and binds **127.0.0.1** unless `HOST` says otherwise.
`buildServer` never listens and never closes the store it was given — the same injection seam as
`verifyOpenFindings(store, …)`, which is what lets `test/server.test.js` drive the whole app over an
in-memory database with `app.inject()` and no port.

`server/routes/findings.js` is encapsulated under `/api` so its rate limiter covers the API and not
the static assets — an app-wide limiter trips on the burst of asset requests a single page load
fires. `GET /api/findings?kind=&status=&limit=&offset=` returns `{generated, total, count, limit,
offset, taxa}`; `total` is the count *before* paging, so a truncated page cannot pass itself off as
the whole backlog.

**Discovery** is `POST /api/discover`, `GET /api/discover/status` and
`POST /api/discover/cancel` — see [Discovery](#discovery-libdiscoverjs-serverjobsjs) below.

**Search** is `GET /api/search?kind=&taxon=&iucn=&limit=&offset=` and
`GET /api/taxa/suggest?q=&limit=` — see [Searching the backlog](#searching-the-backlog-libbacklogindexjs).

**Writes** are `POST /api/findings/:id/confirm`, `POST /api/findings/confirm` (bulk,
`{ids}`, dispatched per-id by kind — see [Confirming](#confirming-libconfirmjs--and-why-it-is-not-verification)),
`POST /api/findings/:id/skip`, `POST /api/findings/:id/pick` (`{inatId}`, `kind='link'` +
`status='ambiguous'` only — see the links-checker section above), `POST /api/uploads` (record an
upload or a P18 pick, read back by `GET /api/uploads`) and `POST /api/import` (the one-time
`localStorage` importer).
All of them sit behind `server/writeGuard.js` and carry a tighter rate limit than reads, because a
confirm spends Wikimedia's API budget and not just ours. `fetchFn` is threaded from `buildServer`
down to `confirmFindings`, so the whole application can be driven over an in-memory database with
no network.

Everything about *why* the headers, limits and validation rules are what they are — including the
CSP hosts that are easy to get wrong, and what the write guard defends against — is in
[threat-model.md](threat-model.md).

### Discovery (`lib/discover.js`, `lib/discoverLinks.js`, `server/jobs.js`)

`discover({store, taxaDb, scope, limit, recheckAfter, onProgress, signal})` is the work; `checkImages.js`
is argument parsing and HTML rendering around it. Four things about it are load-bearing:

- **The child's working directory is the repo root, not the server's.** `server/jobs.js` forks with
  `cwd: REPO_ROOT`, resolved from the module. That is deliberate — a server started from anywhere
  must still find `output/` and `cache/` where the CLI put them — but it is the one place
  `lib/paths.js`'s "relative to the working directory" stops being the whole truth. It matters in a
  container: a discovery run would write `cache/cache-commons-cats.json` **inside the image**, not
  onto the mounted volume — and since slice 10 made discovery genuinely reachable through a
  published port, this stopped being moot and started being a real failure the first time a
  container-triggered run found anything actionable, because the container's root is `read_only:
  true`. Fixed by making that one write best-effort (`lib/utils.js`'s `saveCommonsCatCache`) — see
  [findings-db-roadmap.md](findings-db-roadmap.md#10-discovery-reachable-from-a-deployed-container)
  for how it was found. The underlying fact (that write always lands inside the image, never on the
  mounted volume) is still worth knowing, since anything else that writes to `cache/` from a
  container-triggered run inherits the same trap.
- **It runs in a forked child, never in the server process.** `allInatIds()` materialises 1.4M rows —
  ~1.0 s of blocked event loop and a ~650 MB heap spike — `descendantInatIds()` is an unindexed LIKE
  scan (~0.5 s), and `node:sqlite` is synchronous. In-process, every run would freeze the API in
  bursts and keep the memory; the child also gives crash isolation and makes cancelling a signal.
- **Findings are recorded per iNat batch.** A run is minutes long and spends API budget throughout,
  so writing only at the end meant a killed or cancelled run kept nothing. This is why
  `inatBatches()` is a generator and why `createWikitextContext()` exists — batch-wise generation
  would otherwise re-walk the same lineages and re-fetch the Commons template map every batch.
- **Scope resolution throws, and happens before the run row is opened.** The CLI called
  `process.exit(1)` on an unknown taxon or IUCN code, which over HTTP is a remote kill. The digits
  test in `resolveTaxonScope` is also a guard, not just parsing: `descendantInatIds` interpolates the
  id into LIKE patterns, so `%` would match a 3M-row table.
- **Every scope reduces to a candidate stream.** `candidateSource` is the seam: `{taxon}` and
  `{iucn}` each pick a source function, and `{lat, lng, radius}` (slice 6) is a third one —
  `fetchAreaCandidates` in `lib/areaCandidates.js`, `resolveAreaScope` validating the scope the same
  way `resolveIucn` does. `discover()`'s downstream logic (`inatBatches`, `recordBatch`) never knows
  which source it was handed.

`server/jobs.js` is the state machine: one child at a time (claimed synchronously — an `await`
between the check and the set would let two POSTs both fork), a wall-clock cap *and* a progress
watchdog (Node's `fetch` has no default timeout, so "wedged but alive" is real), and `spawn`
injected so all of it is testable without a process. The child exits on `disconnect`, which is the
only thing that stops it outliving a parent that was killed outright — verified, not assumed.

`SIGKILL` is never reported as a cancel: the OOM killer sends the same signal, and a 650 MB child is
a plausible target for it.

**One runner, dispatched by `config.tool`.** Slice 7 added `lib/discoverLinks.js` (a sibling to
`lib/discover.js`, not a generalisation — see the links-checker section above) without adding a
second job runner, and slice 8 added `lib/discoverNames.js` the same way: `server/discoverChild.js`
picks `discover`, `discoverLinks` or `discoverNames` from a `{images, links, names}` map keyed on
`config.tool` (default `'images'`), and `server/jobs.js` itself needed no change at all — it only
ever forks whatever `discoverChild.js` runs and reads IPC message shapes, never which pipeline
produced them. The consequence, decided deliberately rather than discovered by accident: **only one
discovery run, of any kind, can be in flight at a time** — the single-flight lock in `jobs.js` is
global, not per-tool. `POST /discover`'s `tool` field and `GET /discover/status?tool=` both default
to `'images'` for backward compatibility; `publicStatus()`'s "last run" lookup takes the same `tool`
param, since `jobs.status()`'s *live* progress needs no such choice — only one tool's run can ever
be live.

### Area as a scope (`lib/areaCandidates.js`, `GET /api/discover/area`)

Three functions, each with one job:

- `resolveAreaScope(scope)` — `null` if `lat`/`lng`/`radius` are all absent (no area scope given),
  throws `DiscoveryError` on a partial or out-of-range one, otherwise the three as numbers. Mirrors
  `resolveIucn`'s shape so `discover()` reads it the same way.
- `fetchAreaCandidates(area, opts)` — species observed nearby (`fetchAreaSpecies`, iNat
  `species_counts`, paginated), cross-referenced through `fetchWdTaxaByInatIds` — the same
  P3151-present/P18-absent SPARQL test every other image-scope candidate goes through, not a second
  query shape. `opts.species` lets a caller that already has the map (the CLI, to avoid paying for
  Step 1 twice) hand it in directly.
- `fetchAreaEnrichment(taxonIds, area, opts)` — one iNat request per taxon (`order_by=observed_on`),
  taking the latest date from the first result and up to 3 of the same page's photos. **This is the
  fix** for a real bug: the area checker used to batch 20 taxa per request
  (`taxon_id=id1,id2,...id20`) against one fixed-size shared result window, so taxa that did not
  dominate that window's ordering came back with nothing — verified live (25km around Munich, 331
  qualifying taxa, 69 with a blank date) before the fix, and again after (all 8 sampled taxa
  correct, including a cross-check against a direct single-taxon iNat call). Per-taxon requests have
  nothing shared to starve.

`GET /api/discover/area` (`server/routes/discover.js`) is a preview, not a run: it calls
`fetchAreaSpecies` + `fetchAreaCandidates` only, never `fetchAreaEnrichment` and never `discover()`
— nothing is recorded. That split exists because this route answers **synchronously in the request
handler**, unlike `POST /discover` which forks a child and returns before the real work starts;
`fetchAreaEnrichment` against a real sample was measured at minutes, not seconds, which is well past
the server's `requestTimeout` (30s). So the route is bounded two ways — `radius` capped at 50km
(tighter than `POST /discover`'s 20000km sanity ceiling) and the species sample capped at `limit`
(≤500) — and enrichment happens **client-side**, one row at a time, in `web/js/area.js`, the same
pattern `web/js/gallery.js` already uses for its own cards. `fetchAreaEnrichment` itself is used
only by the CLI (`checkArea.js`), which has no such time limit.

`fetchAreaSpecies`'s `onTotal` callback exists solely so the preview route can report the *true*
species count (`totalSpecies`) even when `maxPages` stops it from fetching all of them — a
side-channel rather than a return-shape change, so the CLI and the existing tests, which just want
the `Map`, are untouched.

`checkArea.js` is a thin CLI wrapper around all three, following the `checkImages.js` precedent:
`fetchAreaSpecies` → `fetchAreaCandidates` (materialized once, since both `discover()` and the
report need the same list) → `discover({scope: area, candidateSource: candidates})` →
`fetchAreaEnrichment` → `generateAreaHTML` (unchanged; its signature never needed to know where its
inputs came from).

### Scheduled top-up (`server/scheduledTopup.js`)

Calls `jobs.start()` directly, in the server process — never over HTTP — so the write guard never
applies to it; see
[threat-model.md](threat-model.md#the-scheduled-top-up-slice-5b--why-it-needs-none-of-the-above).
Since slice 10, `tick()` also runs `maybeBonusRun()` (pure decision in `evaluateBonusRun()`) once
every tool's own guaranteed daily run has settled — a once-a-day bonus draw against the same shared
`discover` token bucket `POST /discover` draws from, taken only if there is real unused capacity
left late in the day. Two things worth knowing before touching the rest of it:

- **The decision logic is a pure function, `evaluateTopup()`.** It takes `jobsState`,
  `lastScheduledRun`, the cached `quiet` set and `nowMs` as plain values and returns
  `{action, reason}` with no side effect — the whole gate (running-lock, daily-once, quiet-hours,
  deadline catch-up) is tested through it directly, with no fake timers or DB needed. `tick()` in
  `createScheduledTopup()` is thin glue around it: fetch the current state, call it, act on the
  result.
- **`store.quietHoursOfDay()` is cached for 24h, not recomputed per tick.** That cache *is* the
  hysteresis the plan asked for — recomputing on every tick would let one noisy hour flip the
  eligible set tick to tick. A day with too little `request_log` history (`sampleDays` below
  `TOPUP_QUIET_MIN_SAMPLE_DAYS`) is treated as "every hour eligible", not "wait" — a fresh
  deployment should not sit idle for a week waiting to earn the right to run.
- **One shared config, tried per tool in a fixed order.** `tick()` loops `TOOLS = ['images',
  'links', 'names']`; each has its own daily-once gate (`store.latestRun(tool,
  {triggeredBy:'schedule'})` reads that tool's own history), but only one job can ever be running,
  so a tick starts at most the first tool that is both eligible and hasn't run today — a skip for
  one tool falls through to the next rather than ending the tick. `getStatus().ranToday` is
  therefore per tool (`{images: bool, links: bool, names: bool}`), not a single flag. There is
  deliberately no `TOPUP_LINKS_*`/`TOPUP_NAMES_*` config: one `TOPUP_ENABLED` switch and one
  taxon/iucn scope drives all three — Livia's call, over giving each tool its own independent
  schedule.

The daily-once gate reads `runs.triggered_by = 'schedule'`, which means it has the same blind spot
`discover()`'s own "a bad scope leaves no run behind" design has, one layer further out: a missing
taxa index throws in `discoverChild.js` **before** `discover()` opens a run row at all, so that
particular failure is invisible to the gate and gets retried every `TOPUP_CHECK_INTERVAL_MINUTES`
rather than once a day. Written up in
[findings-db-roadmap.md](findings-db-roadmap.md#5b-scheduled-top-up--done) as accepted, not fixed.

### Searching the backlog (`lib/backlogIndex.js`)

Which taxa *already on the worklist* are in a clade. The findings database knows each taxon's iNat
id and nothing about the tree; the taxa index knows the tree and nothing about the backlog. This is
the join, kept out of the route so it can be tested without HTTP.

`createBacklogIndex({store, taxaDb, kind = 'image', status = 'open'})` took `kind` from the start
(slice 5c), but `server/routes/search.js` didn't thread it through until slice 7: `GET /search`'s
querystring gained a `kind` property, and the route's one memoised `backlogIndex()` became one
memoised **per kind** (`Map<kind, index>`, invalidated together when the taxa-index handle changes)
rather than a single closure variable — a link search and an image search now warm independent
ancestor-caches instead of thrashing one shared one. `web/search.html`/`search.js` read `?kind=`
once at boot (fixed for the page's life, unlike `taxon`/`iucn` which change per query) and carry it
on every URL and API call they write, including into `POST /discover`'s `tool` field via
`createTopup({tool})` — search's "Find more" is also links' and names' only on-demand discovery
entry point, there being no bespoke scope form on `links.html` or `names.html` themselves. Slice 8
added the third `kind`/`THEAD_HTML` value the same way — `search.js`'s `KIND` resolution had been a
binary `=== 'link' ? 'link' : 'image'` check since slice 7, widened to a real three-way rather than
grown into a nested ternary.

**It walks up, not down** — the one place this deliberately departs from the roadmap, which called
for `descendantInatIds()` and a set intersection. Measured against the real index:

| | |
|---|---|
| `descendantInatIds('47217')` (Orchidaceae) | **452 ms**, 21,973 ids |
| 5,000 `ancestorIds()` lookups | **24.8 ms** |
| Orchidaceae search, cold memo → warm | **4.9 ms → 0.14 ms** |

Three reasons, in order of weight. `descendantInatIds` is an unindexed four-way `LIKE` over ~3M
rows, so it is a **full scan whatever the clade size**, and `node:sqlite` is synchronous — in the
server process that is half a second of blocked event loop, which is the exact thing slice 5 forked
a child to avoid. Cost scales with the **backlog** rather than the tree (Insecta is ~1M ids, and
`WHERE inat_id IN (…)` would blow past SQLite's variable limit long before that). And the memo is
keyed by *backlog taxon*, so it warms once and every later clade is set membership, where a
per-clade cache pays the full price again for each new clade searched.

Discovery is untouched: it still needs the descendant set, still resolves it in the child.

Two things that are easy to get wrong here:

- **The row list is not cached.** It was, invalidated on run completion — which misses skips and
  confirms, because those settle a finding without any run being involved, so the page kept offering
  work that had just been resolved. Re-reading is one indexed query; the memo is what is expensive.
- **The composition strip descends past a single child.** Every plant in a botanical backlog is a
  vascular flowering plant, so one rank below Plantae is a dead end — a fact about botany, not a way
  through the worklist. It walks down to the first branch point and reports where it got to, which
  is why the response carries `composition.under` as well as `composition.entries`.

Both table pages request 100 rows at a time through `web/js/pager.js` — a row carries a block of
draft wikitext, so it is tall, and the API's 2000 ceiling would be a page nobody reaches the end of.
An offset past the end falls back to the last page that exists, because confirming the last rows of
the last page would otherwise leave an empty table.

On the search page `offset` also rides in the URL next to `taxon` and `iucn`, so a page is linkable
and Back steps through pages, but it is built by a **separate** `apiQuery()` rather than by
appending to the address-bar query string: emitting `offset` from both sends it twice, Fastify
parses a repeated parameter as an array, and the schema rejects it — a 400 that shows up only as a
page that quietly stops updating. Changing what you searched for drops the offset, because page 4
of the orchids is not a place to land in the beetles.

**Paging the worklist required moving one lookup to the server**, and the shape of the bug is worth
keeping: `main.js` built a `qid → finding id` map from the rows it had rendered, and "Confirm
pending" resolved the P18 picks through it. Paged, that silently skips every pick whose taxon is not
on the visible page — a wrong answer wearing the shape of a right one, since the panel would still
report "0 of 1 confirmed". `p18Picks()` now joins `findings` and `taxa`, so each pick carries its own
`findingId` and a `taxonName` that falls back to the taxa table, and the client resolves nothing.
Both joins are `LEFT`: a pick whose finding was skipped or confirmed away must stay listed, or it
can never be withdrawn. For the same reason `legacy.read()` scans `localStorage` for `^done-Q\d+$`
instead of testing the loaded qids — anchored so the other reports' `done-<segment>-<qid>` keys
still fail it.

`resolveTaxonId` (split out of `resolveTaxonScope`) resolves a name without the descendant scan.
The `^\d+$` test stays on that path: it is the guard keeping a `%` out of the LIKE patterns, not
parsing. And `suggest()` ranks by **rank**, not by ancestry depth — depth was the vocabulary-free
proxy and it fails, because lineages differ wildly in how many intermediate ranks they carry, so a
genus in a shallow group outranks a family in a deep one and `Orch` answers *Orchesellaria* before
*Orchidaceae*.

### Confirming (`lib/confirm.js`) — and why it is not verification

Both read the same `wbgetentities` response through `readImageFacts()`, and then ask **different
questions of it**:

| | `verifyOpenFindings` (`npm run verify`) | `confirmFindings` (the app's Confirm button) |
|---|---|---|
| Question | Does this taxon still need an image? | Did *my* edit land in full? |
| Test | P18 present | P18 **and** the commonswiki sitelink present |
| Resolves to | `fixed_upstream` | `done` |

So a taxon whose P18 you added but whose sitelink statement failed will **refuse to confirm** and
then be swept to `fixed_upstream` by the next verify run. That is not a bug: it no longer needs an
image, so it is no longer this checker's work, even though your batch was half-applied. The confirm
response names which half is missing (`missing_p18` / `missing_sitelink` /
`missing_p18_and_sitelink`) so the difference is visible rather than mysterious.

A failed confirm is a **no-op** — the finding keeps `open` and only `verified_at` moves — never an
error state, because a QuickStatements batch can be queued and confirming too eagerly must be safe.
An *upstream* failure is different again: it answers 503 and touches nothing, so retrying is safe.
`skip` is the escape hatch for a taxon that will never have a Commons category.

**Links get their own predicate, not a generalisation of this one** (`confirmLinkFindings`): one
statement (P3151), no sitelink pairing, no upload/pick bookkeeping — "what counts as complete"
genuinely differs in shape here, not just which property is read. A bulk confirm's `ids` can span
kinds (the app's QuickStatements panel confirms whatever was just pasted, regardless of which page
built it), so `confirmByKind(store, ids, opts)` groups by each finding's own kind, runs each kind's
predicate once, and reassembles results in the order requested. The route layer needed no change —
it already just forwarded ids and returned results; only this dispatch layer knows kinds exist.

**Names get a third predicate, `confirmNameFindings`, and this one genuinely differs in shape from
both siblings**: a name finding proposes *several* P1843 statements at once (one per missing
locale), not one. Each locale is re-checked independently against live Wikidata — all-live is
`done`; some-live trims `payload.missing` to what's still absent via `recordFinding()` (a fresh,
smaller candidacy, exactly the "re-check upserts in place" path a link conflict's reopening already
uses) and the finding **stays `open`**; none-live is the usual no-op. `confirmResultSchema`
(`server/routes/findings.js`) has no wildcard properties — Fastify's serializer silently drops
anything not declared there — so the partial-vs-none distinction lives only in the existing
`reason` string (`partially_confirmed` / `missing_names`), not a new response field.

### Verification (`lib/verify.js`, `verifyFindings.js`)

`verifyOpenFindings(store, {kind, limit, fetchFn})` re-checks open findings against the **Action API, never SPARQL** — WDQS (the Wikidata Query Service) lag would report an image still missing right after you added it, and a second one would go on. `fetchFn` is injectable, the repo's established seam for faking the network in tests.

Requests use `redirects=no`. That is the load-bearing simplification: the API then reports a redirect exactly like a deleted entity, so since merged and deleted both resolve to `gone`, a single `entity.missing` check covers both and no requested-vs-returned id comparison is needed. An entity absent from the response entirely is also treated as `gone`, so a finding can never get stuck open because the API stopped mentioning its item.

Results go through **`store.markVerified()`, never `recordFinding()`** — the latter overwrites `payload`, and with `payload` undefined it writes NULL, so reusing it here would wipe the stored draft wikitext of every finding the pass touched. `test/verify.test.js` guards exactly that.

**`kind: 'link'` dispatches to `verifyLinkFindings`, a real fix not just an addition.** Before slice
7, `verifyOpenFindings` called `readImageFacts` unconditionally regardless of `kind` — passing
`kind: 'link'` would have silently applied the P18 predicate to a link finding. The dispatch
narrows an existing bug rather than widening a new one. `readLinkFacts` reads P3151 alone (a link
finding proposes one statement, no sitelink asymmetry to preserve), and the pass also re-verifies
`conflict` findings, not just `open` ones — a conflict's fate depends on an item it doesn't own
(whoever currently holds the disputed iNat id), so that item is fetched too, and a conflict whose
competing claim has gone or moved re-opens **via `recordFinding()`**, not `markVerified()` — the
same "re-check upserts in place" path negative-status expiry already uses, because this is a fresh
candidacy, not a "still true" observation, and `resolved_at`/`resolution` are terminal-state
columns that must not be stamped on a row that is, again, actionable.

**`kind: 'name'` dispatches to `verifyNameFindings`.** `readNameFacts` returns the *whole* live
P1843 set (as `"locale:name"` keys, case-folded), not one value — a name finding proposes several
statements, so each of `payload.missing`'s entries is tested against that set independently. Every
proposed locale live → `fixed_upstream`. Some live → the same `recordFinding()`-not-`markVerified()`
re-open path link's conflict-reverification established, trimming `missing` to what's still absent
and leaving the finding `open`. None live → `markVerified()` with no status change, same as every
other kind's "looked, still actionable" case. `VerifyResult`'s existing `{verified, fixedUpstream,
gone, stillOpen}` shape has no field distinguishing "trimmed but still open" from "unchanged, still
open" — both land in `stillOpen`, a deliberate simplification rather than growing the typedef for
one kind.

### Batched entity fetches (`utils.fetchEntitiesBatched`)

One helper owns the `wbgetentities` ceiling of **50 ids per request** and the Wikimedia guidance of **≤3 concurrent requests** (the three call sites it replaced each used 4), plus retry via the shared `fetchWithRetry`. `sitefilter` and `languages` are parameters rather than constants because callers want different things — the ancestor walk needs `specieswiki`, verification needs `commonswiki`, place labels need `props=labels&languages=en` — and a single widened filter would make every batch carry payload most callers never read.

A well-formed but deleted or merged id returns per-entity `{id, missing: ''}`, so one bad id does not fail its batch. Only a *malformed* id (out of range) fails the whole request with `no-such-entity`; QIDs sourced from Wikidata cannot hit that.

## Vernacular name language codes (`lib/getInatNames.js`)

iNaturalist returns Chinese names under `zh-CN` and `zh-TW`. These are normalised to `zh-hans` and `zh-hant` respectively before comparison with Wikidata, because Wikidata uses lowercase script subtags for these languages.

## Genus-as-vernacular leak (`lib/discoverNames.js`)

iNaturalist sometimes stores the genus name itself as a vernacular name for a species in certain locales (e.g. `de:"Olyra"` for *Olyra longicaudata*). These pass through the scientific-name exclusion filter — which only strips the full binomial — unless explicitly checked. `discoverNames.js` filters them by comparing each candidate name against the first word of the scientific name (`sciName.split(' ')[0]`).

## Taxonavigation ancestor traversal (`lib/generateWikitext.js`)

The wbgetentities ancestor walk is capped at `MAX_ANCESTOR_DEPTH` (40) rounds, shared by `buildAncestorCache` and `resolveAncestors`. The taxonavigation block itself only needs ~15 levels (Lepidoptera sits roughly that far above species rank thanks to many unranked intermediate clades), but the **endemic** category resolution (below) needs to reach the kingdom for non-vertebrates, whose Wikidata lineage runs ~30 cladistic levels deep. The deep clades are highly shared across taxa, so once the per-batch frontier converges onto the tree-of-life backbone the extra rounds each fetch only a handful of entities — negligible API cost.

## Endemic categories (`lib/generateWikitext.js`)

From P183 ("endemic to"), the draft adds Commons `Endemic <group> of <place>` categories. For each P183 place, candidate titles are generated most-specific → general and the first that actually exists on Commons (via `resolveCommonsCategory`, soft redirects followed) is emitted; nothing is emitted otherwise.

- **Group word** comes from the ancestor chain's scientific names (matched by name, not rank QID, so it's immune to rank-QID merges): a specific class word from `ENDEMIC_GROUP_BY_CLASS` (`Aves→birds`, `Mammalia→mammals`, `Amphibia→amphibians`, `Reptilia→reptiles`, ray-/cartilaginous-/jawless-fish classes→`fish`), else the kingdom word from `ENDEMIC_GROUP_BY_KINGDOM` (`Animalia→fauna`, `Plantae→flora`, `Fungi→fungi`), then `species` as a final fallback. A matched animal class implies `fauna` directly — necessary because the `Animalia` node sits beyond the walk for deep lineages (birds run through `Dinosauria`). Note `Sarcopterygii`/`Osteichthyes` are deliberately **not** in the fish map: they cladistically contain all tetrapods, so they'd mislabel frogs/birds as "fish".
- **Place** is the P183 value's English label, tried as both `… of <place>` and `… of the <place>`. A label that differs from the Commons place name (e.g. Q22502 "Taiwan Island" vs the "Taiwan" used by `Endemic flora of Taiwan`) simply yields no match — safe, never wrong.

Commons existence results are cached in `cache/cache-commons-cats.json` (`checkCommonsCategories`/`resolveCommonsCategory` in `lib/utils.js`, ported from the browser-side `web/js/enrich.js` so `web/` stays self-contained), reused within and across runs.

## Commons Taxonavigation templates (`lib/generateWikitext.js`)

Every Commons taxon category uses `{{Taxonavigation|include=X|Rank|Name|…}}`. The `include=` value names a template from [Category:Templates to include in Taxonavigation](https://commons.wikimedia.org/wiki/Category:Templates_to_include_in_Taxonavigation); that template renders everything above its level, so only ranks **below** `include=` are listed manually.

### Orders with dedicated wrapper templates

These bypass `{{Taxonavigation}}` entirely — use the wrapper directly:

| Wrapper | Group | Detection (Wikidata) | Notes |
|---|---|---|---|
| `{{Coleoptera\|familia=…\|…}}` | Beetles | ancestor P105=Q36602, P225="Coleoptera" | params: `familia`, `subfamilia`, `tribus`, `subtribus`, `genus`, `species` (epithet only), `auth` |
| `{{Lepidoptera\|familia=…\|…}}` | Butterflies & moths | ancestor P105=Q36602, P225="Lepidoptera" | same params minus `subtribus`; sits ~15 P171 levels above species (many unranked clades) |

`Coleoptera (include)` and `Lepidoptera (include)` are internal templates used by the wrappers — do not use them directly as `include=`.

### Family-level suffixed templates

| Group | Suffix | Example |
|---|---|---|
| Angiosperms (flowering plants) | `(APG)` | `Asparagaceae (APG)` |
| Birds (Aves) | `(IOC)` | `Corvidae (IOC)` |
| Ferns (Polypodiopsida) | `(Smith)` | `Polypodiaceae (Smith)` |

When a suffixed family template is used as `include=`, the manual chain starts at **subfamily** level — Ordo and Familia are rendered inside the included template and must not be repeated.

Conifers use plain-name family templates (`Cupressaceae`, `Pinaceae` — no suffix).

### Higher-level fallbacks (no family template exists)

Use the most specific ancestor that has a Commons template: `Reptilia`, `Amphibia`, `Mammalia`, `Actinopterygii`, `Agaricomycetes`, `Hemiptera`, `Angiosperms`, `Aves`, `Polypodiopsida`, etc.

### Fungorum templates

Two templates exist for Index Fungorum entries: `{{Fungorum genus}}` (rank = genus, Q34740) and `{{Fungorum species}}` (all other ranks). Using the wrong one miscategorises the Commons page.

### IUCN Commons categories

Species with IUCN status get `[[Category:IUCN X species]]`. LC (Q211005) has no Commons maintenance category and is omitted. Category names:

| P141 QID | Code | Commons category |
|---|---|---|
| Q219127 | CR | IUCN Critically endangered species |
| Q96377276 | EN | IUCN Endangered species |
| Q278113 | VU | IUCN Vulnerable species |
| Q719675 | NT | IUCN Near Threatened species |
| Q3245245 | DD | IUCN Data Deficient species |
| Q237350 | EX | IUCN Extinct species |
| Q239509 | EW | IUCN Extinct In The Wild species |

Note: "Critically **e**ndangered" is lowercase; "Extinct **I**n **T**he **W**ild" is mixed caps. The correct QID for Endangered is `Q96377276`, not `Q11394`.

### Category placement line

`[[Category:ParentName|sortKey]]` at the bottom is always required explicitly — the auto-categorisation inside wrapper/APG/IOC templates fires only for gallery pages, not category pages. For species: `[[Category:GenusName|epithet]]`. For genera and above: `[[Category:ImmediateParentName|taxonName]]`.

---

## SPARQL patterns (`lib/utils.js`, `checkLinksStats.js`)

The endpoint is `https://query.wikidata.org/sparql` (Blazegraph). Since the May 2025 [WDQS graph split](https://www.wikidata.org/wiki/Wikidata:SPARQL_query_service/WDQS_graph_split) it serves the **main** subgraph (scholarly articles moved to a separate `query-scholarly` endpoint); taxon data is in the main graph, so the default endpoint is correct here. Always send a descriptive `User-Agent` — Wikidata blocks anonymous bots.

### TSV format for large result sets

Request TSV instead of JSON to avoid the ~7 MB JSON truncation limit and control-character parse errors:

```js
const url = `https://query.wikidata.org/sparql?query=${encodeURIComponent(query)}`;
const res = await fetch(url, { headers: { ...HEADERS, 'Accept': 'text/tab-separated-values' } });
```

**Critical:** do not use `wbk.sparqlQuery(query)` as the URL — it appends `format=json` which overrides the Accept header and returns JSON regardless. Use the raw endpoint URL with no `format=` param.

TSV parsing: header row has `?varName` columns; URI cells are `<http://…>`; literal cells are `"value"`. Strip BOM (`﻿`) from the first line.

### Large-dataset enumeration (WDQS can't scan these sets)

Two filtered sets are too big for WDQS to scan: taxa with `P225` and no `P3151` (**~2.94 M**, the links/stats target) and taxa with `P3151` and no `P18` (**~619 K**, the images target). WDQS/Blazegraph times out even on `SELECT (COUNT(*) …)` for either (65 s), as it does on a rank-restricted (`species` only) `ORDER BY`/keyset query. `LIMIT/OFFSET` re-scans from row 0 each page, so it dies at depth (429/504) and silently truncates. **Do not try to page these sets through WDQS.**

**WDQS approaches that don't work** (all measured against the live endpoint):
- `LIMIT/OFFSET` to cover the whole set → 429/504 at high offset; pages overlap/skip without `ORDER BY`; a 200 can return a truncated body
- `ORDER BY ?item` (even rank-restricted) → 504
- `FILTER(?item > wd:QN)` → 0 rows (IRI comparison unsupported); `BIND(xsd:integer(STRAFTER(…))) FILTER(?qnum > N)` → 504 on page 1
- `STRSTARTS(?taxonName, "A")` letter partitioning → full scan, no text index → slower than OFFSET
- adding `?item wdt:P141 wd:<qid>` to a large `VALUES`-by-name query → bad query plan → 504 (fetch P141 via `OPTIONAL`, filter in JS)

**What works — two complementary backends:**
1. **CirrusSearch (`cirrusCount()` in `lib/utils.js`)** for exact counts. The MediaWiki search API (`list=search`, `haswbstatement:`/`-haswbstatement:`) is Elasticsearch-backed: it returns exact `totalhits` instantly and its negation partitions cleanly (WITH + WITHOUT a property sum to the total). Include `haswbstatement:P31=Q16521` to match "instance of taxon". It caps any single query at 10 000 results, so it is used for **counting**, not enumeration.
2. **Query Wikidata BY value (`fetchWdTaxaByValues()` in `lib/utils.js`)** for enumeration — the "flip". We hold a complete local key set in `taxa.db`, so instead of scanning Wikidata we probe it with `VALUES ?value { … } ?item wdt:<valueProperty> ?value . FILTER NOT EXISTS {<absentProperty>}` in bounded batches (an indexed lookup, ~10 k values/batch in seconds; full pass in minutes). Two wrappers:
   - `fetchWdTaxaByNames()` — by P225 name, absent P3151 (~1.4 M names). Used by `checkLinks.js` (collect matches up to `--limit`) **only when no IUCN status is given**, and by `checkLinksStats.js` (full pass; no-match = `total − match − ambig`).
   - `fetchWdTaxaByInatIds()` — by P3151 iNat ID, absent P18 (~1.4 M ids). Used by `checkImages.js` **only when no IUCN status is given**, skipping cached ids until `--limit` new candidates are collected.

   **Exception — `--iucn <code>` on `checkImages.js` / `checkLinks.js`:** when an IUCN status *is* given, do **not** flip. `fetchWdTaxaByIucn()` (wrappers `fetchWdImagesByIucn()` / `fetchWdLinksByIucn()`) runs a single direct query (`?item wdt:P141 wd:<qid> ; wdt:<valueProperty> ?value . FILTER NOT EXISTS {<absentProperty>}`). Here P141 is the selective constraint, so the filtered set per status is small (images: CR ~2 k, even LC ~30 k; links: EN ~2.5 k) and WDQS answers in 1–6 s. The flip would instead brute-force all ~1.4 M values across ~141 batches, and because the status filter is client-side the `--limit` early-exit never fires for rare statuses — it was scanning the whole key set to find a few thousand rows (the regression this path fixes). The flip is reserved for the unfiltered case, where the full absent-property set (~619 K no-P18 / ~3 M no-P3151) genuinely can't be scanned.

   Coverage note: the flip only reaches values present in `taxa.db` (active iNat taxa). For images this means WD items whose P3151 points to an inactive/merged iNat taxon are skipped — acceptable, as they have no current iNat photo to source. The direct `--iucn` query has no such restriction (it reads the value straight off the WD item).

**POST vs GET:** large `VALUES` lists exceed the GET URL length limit, so `fetchWdTaxaByValues()` uses `sparqlPost()` (form-encoded `query=` body). `sparqlPost()` shares TSV parsing and 429/502/503/504 backoff with `sparqlTSV()`. P141 is fetched via `OPTIONAL` and the `iucnQid` filter applied in JS — adding `?item wdt:P141 wd:<qid>` to a large `VALUES` query makes WDQS pick a bad plan and time out.

### CirrusSearch (MediaWiki search API) cheatsheet

Endpoint `https://www.wikidata.org/w/api.php?action=query&list=search&srnamespace=0&srinfo=totalhits&srprop=&format=json&srsearch=<query>`. Elasticsearch-backed, so it indexes **independently of WDQS** — expect a few-item freshness lag between the two (verified: CirrusSearch reported 1,043 CR no-P3151 taxa vs 1,036 live on WDQS).

- **`haswbstatement:`** — `haswbstatement:P225` = has the statement; **`-haswbstatement:P3151`** = lacks it. Value equality: `haswbstatement:P141=Q219127`, `haswbstatement:P105=Q7432`. Multiple space-separated terms are ANDed. Negation partitions exactly (WITH + WITHOUT a property sum to the total). Matches **direct/truthy statements only** — there is no transitive form, so you cannot filter "descendant of Insecta".
- **Hard caps:** `sroffset > 10000` → error `cirrussearch-offset-too-large`; `srlimit` max 500. Usable for counts and small/partitioned enumeration, **not deep paging**. This is why the ~2.5 M `species` rank can't be tiled out — there is no enumerable indexed sub-key fine enough to keep every bucket under 10 000.
- **`inlabel:Token`** matches whole label tokens (e.g. `inlabel:Carabus` matches every "Carabus …" binomial). Prefix wildcards (`inlabel:Aba*`) are unreliable (inconsistent counts) — don't depend on them for partitioning.
- **Names without WDQS:** `generator=search&prop=entityterms&wbetlanguage=mul` returns the `mul` label, which for taxa is the scientific name — an alternative way to enumerate name+QID together if a local name list isn't available (we don't need it here since `taxa.db` already has every name).

---

## Taxonomy tree comparison and `--auto` certainty filter (`lib/utils.js`, `lib/discoverLinks.js`)

`compareAncestorTrees(wdChain, inatChain)` aligns the WD and iNat ancestor chains by rank name (case-insensitive), counts agreements and disagreements among labeled ranks present in **both** chains, and returns `{ matches, mismatches, matchedRanks }`. Only the 9 ranks in `WD_RANK_LABELS` can be labeled on the WD side (genus, family, superfamily, subfamily, tribe, subtribe, order, subclass, class); iNat rank strings are used as-is. Ranks present in only one chain are ignored — they do not count as mismatches. This return shape is exactly what gets stored as a finding's `evidence` — see [docs/links.md#statuses](links.md#statuses).

The `--auto` certainty filter, `isAutoEligible(evidence)` in `lib/discoverLinks.js` (exported so `lib/verify.js` and `lib/pick.js` can recompute it after a conflict re-opens or a candidate is picked, without duplicating the formula), requires: `mismatches === 0 && matches >= 3 && (matchedRanks.includes('family') || matchedRanks.includes('order'))`. The family-or-order anchor prevents three coincidentally agreeing intermediate ranks (e.g. subfamily/tribe/subtribe within a split family) from triggering auto-approval on an actually wrong match. Computed once at discovery time and stored as `autoEligible` on the finding — the CLI's `--auto` export and the app's QuickStatements panel both just read the flag, rather than each recomputing it from a chain.

**Known recurring disagreement — Noctuidae/Erebidae:** many moth genera were reclassified from Noctuidae to Erebidae; WD and iNat have not fully converged on this split. Affected genera produce a family-level mismatch for otherwise correct matches and correctly fail the auto-filter, appearing in `links.html` for human review.

---

## Wikidata QID reference

Most QIDs live in code constants; this is the human-readable map. **QIDs can change via item merges** — if rank or ancestor detection breaks unexpectedly, re-verify these against the live items.

**Taxon ranks** (`WD_RANK_LABELS` in `lib/utils.js`, `RANK_LABELS` in `lib/generateWikitext.js`): genus `Q34740`, family `Q35409`, superfamily `Q2136103`, subfamily `Q164280`, tribe `Q227936`, subtribe `Q3965313`, order `Q36602`, subclass `Q5867051`, class `Q37517`. "Instance of taxon" is `Q16521`.

**IUCN status (P141)** QIDs and their Commons categories: see the [IUCN Commons categories](#iucn-commons-categories) table above. Note EN is `Q96377276` (not `Q11394`).

**`{{IUCN}}` template logic** (`lib/generateWikitext.js`): when an item has both P627 (Red List numeric ID) and P141 (status), emit `{{IUCN|code|id|name|authority}}`, which auto-categorises the Commons page into the correct IUCN maintenance category. With P141 only (no P627), emit a manual `[[Category:IUCN X species]]` instead.

**Source item:** the iNaturalist Wikidata item `Q16958215` is used as the `S248` (stated in) source on generated P1843 vernacular-name references (`checkNames.js`).
