# Developer notes

Implementation details for contributors and for Claude to read on demand when debugging or extending the tools.

Its companion is [security.md](security.md) — the threat model for `server/`, why each header, limit and validation rule is there, and what is deliberately not done. Anything touching the HTTP surface belongs in that document, not this one.

## Module wiring

Each entry script wires shared modules together; all data flows in memory.

Source is grouped by role: entry scripts (`check*.js`, `draftCategory.js`) sit at the repository root; shared core/domain logic is in **`lib/`** (`utils`, `cache`, `getInatTaxaDb`, `getFromInat`, `getInatNames`, `generateWikitext`); output rendering is in **`report/`** (the `generate*HTML` builders and their shared `htmlShared`); the HTTP layer is in **`server/`**. The diagrams reference modules by their real paths; method-call notation like `utils.foo()` / `getInatTaxaDb.bar()` refers to `lib/utils` / `lib/getInatTaxaDb`.

### Image checker (`checkImages.js`)
```
checkImages.js
  └─ lib/getInatTaxaDb.js {allInatIds()}: all iNat taxon IDs (drives the Wikidata query)
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

### Vernacular names checker (`checkNames.js`)
```
checkNames.js
  └─ SPARQL → Wikidata: all taxa with P3151
       └─ lib/generateWikitext.js (fetchEntities): Wikidata P225 + P1843 per item
       └─ lib/getInatNames.js: iNat /v1/taxa?all_names=true → names per taxon
       └─ diff: iNat names absent from Wikidata P1843 (case-insensitive, scientific name excluded)
       └─ report/generateNamesHTML.js: writes output/names.html (QuickStatements + aggregate field)
```

### iNat links checker (`checkLinks.js`)
```
checkLinks.js
  └─ lib/getInatTaxaDb.js: SQLite taxa index (~124 MB, built from iNat open-data S3 dump)
       → get(name) → {inatId, rank} | undefined   (undefined = not found or homonym)
       → getAll(name) → [{inatId, rank}]           (all active taxa sharing the name)
       → allNames() → all distinct iNat names       (drives the Wikidata query)
  └─ utils.fetchWdTaxaByNames() → Wikidata: query BY iNat name in VALUES POST batches
       → taxa with P225 = an iNat name but no P3151 (IUCN via OPTIONAL, JS-filtered)
       → with --iucn: utils.fetchWdLinksByIucn() runs one direct P141-filtered query instead
       → --limit caps collected candidates (real matches), not raw taxa scanned
  └─ Ambiguous collection: names where get() is undefined but getAll() finds 2+ taxa
  └─ SPARQL → Wikidata: found iNat IDs already on other items (conflict detection)
  └─ SPARQL → Wikidata: P13177 (homonymous taxon) to filter false conflicts
  └─ getInatTaxaDb.getAncestors(inatId): iNat ancestor chain from SQLite (no API call)
  └─ utils.fetchWdAncestorChains() (wdt:P171+, batches of 50): Wikidata ancestor chain
  └─ report/generateLinksHTML.js: writes output/links.html + output/inat-links-conflicts.json
  └─ report/generateAmbiguousHTML.js: writes output/links-ambiguous.html (one row per iNat candidate)
```

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

## Output & cache locations (`lib/paths.js`)

All generated files go under two gitignored, auto-created top-level dirs, so nothing but source sits in the repo root. `lib/paths.js` centralises this: `outputPath(name)` → `output/<name>` (deliverables), `cachePath(name)` → `cache/<name>` (cross-run caches), and `ensureParentDir(file)` `mkdir -p`s the parent right before a write (called by every writer — the generators, `lib/cache.js`'s `saveCache`, and `lib/utils.js`'s `saveCommonsCatCache`).

- **`output/`** — `drafts.html`, `names.html`, `links.html`, `links-ambiguous.html`, `links-auto.qs`, `inat-links-conflicts.json`, `area.html`. Report builders default their `outputFile` param to `outputPath(...)`, so a caller can still redirect a single report elsewhere.
- **`cache/`** — `cache-images.json`, `cache-names.json`, `cache-links.json` (per-checker "already scanned" sets) and `cache-commons-cats.json` (Commons category existence). Kept out of `output/` on purpose: clearing reports mustn't blow away the caches, or every re-run re-scans from scratch.

One thing deliberately lives elsewhere: the ~124 MB iNat taxa SQLite index (`~/.cache/wikidata-inat-checker/`, managed by `lib/getInatTaxaDb.js`).

## Tests (`test/`, `npm test`)

`node --test` runs `test/*.test.js` — a dependency-free unit suite for the pure logic, no network, sub-second. Coverage: arg parsing (`parseArgs` incl. `--key=value`, `parseLimit`, `parseIucnArg`), `chunk`/`qidFromUri`/`escapeHtml`, `compareAncestorTrees`, the IUCN code↔QID inverse, the taxa-index queries (`descendantInatIds`/`getAncestors`/`get`), and the report scaffold (`extractTaxonName`, `doneScript` key namespacing, `renderReportPage`). Add cases here when you touch that logic.

The taxa-index tests don't download the 180 MB dump: `lib/getInatTaxaDb.js` exports `createTaxaAccessor(db)` (the query layer split out from `loadTaxaDb`), so a test builds an in-memory `node:sqlite` DB with a handful of fixture rows and exercises the real queries against it. The `descendantInatIds` test deliberately models the Panthera case (species as direct children of a genus) — it fails against the old two-`LIKE` query, guarding that regression.

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

Schema v1 is `taxa` / `findings` / `runs`, all `STRICT`, with the version in `PRAGMA user_version` and migrations applied one per transaction by `migrate()`. `createFindingsStore(db)` is split from `openFindingsDb(file)` for the same reason `createTaxaAccessor` is split from `loadTaxaDb` — so tests can pass an in-memory database.

**Reading it: `listFindings({kind, status, limit, offset})`**, with `openFindings(kind)` as its unlimited `status: 'open'` case. Two details are load-bearing:

- **The default limit is "no limit" (`LIMIT -1`).** `drafts.html` renders the whole backlog off `openFindings()`, so a page size defaulted in the store would silently drop rows from it — a data-loss bug that looks like a display bug. HTTP callers cap it themselves, in their route schema.
- **The tiebreak is `f.id`, not `f.qid`.** `qid` is TEXT, so `Q9` sorts after `Q10`, and `discovered_at` ties are the norm within one batch — paging over that ordering would repeat and skip rows.

Rows carry `id` and `status` alongside the render fields, because the HTTP API addresses a finding by its id.

**Two processes, one file.** Since the server reads the database while a checker writes it, `openFindingsDb` sets `busy_timeout` **before** `journal_mode = WAL` — the WAL switch itself takes a brief exclusive lock, and with no timeout in effect it fails outright with `SQLITE_BUSY` when another process is mid-write. For the same reason `migrate()` uses `BEGIN IMMEDIATE` and re-reads `user_version` *inside* the transaction: with a deferred `BEGIN` and the version read outside, two processes opening the same fresh database both see 0, both begin, and the loser dies on `table taxa already exists`.

**Schema v2 adds `uploads`** — what has been uploaded to Commons, and which photo is a taxon's pending P18 pick. Both lived in `localStorage`, where no checker could see them and a cleared browser profile destroyed them; the pick was worse than that, being deleted the moment the QuickStatements were copied, so nothing recorded which file an edit was supposed to use. `dest_file` is the natural key (it is what the app computes for a photo and what Commons is asked to name the file), `qid` is nullable so an imported filename that does not parse back to a taxon is still kept, and a **partial unique index** (`ON uploads(qid) WHERE is_p18 = 1`) makes "at most one pick per taxon" a database guarantee rather than a convention. Nothing in this table is verified against Commons — the app only pre-fills the upload form, so every row is the user's own claim.

**Statuses.** `open` (photos + a draft), `no_draft` (photos but no P225 or no family template — still fixable by hand, and previously discarded silently), `no_photos`, plus `done` / `skipped` / `fixed_upstream` / `gone` reserved for later slices. A taxon whose iNat batch *errored* gets no row at all, which is why `processInatIds` returns a `failed` set: recording an unanswered request as "no photos" would write the taxon off for the whole recheck window.

**Negative results expire, settled ones do not.** `no_photos` / `no_draft` carry `checked_at` and stop being trusted after `--recheck-after` days (default 90, `0` = recheck all), because CC-licensed photos keep being uploaded and missing P225s keep being filled in. `skipQids()` encodes this: everything sticky always skipped, negatives skipped only while fresh. **The trap:** skipping only `open` would resurface every taxon deliberately passed over on the next top-up — `test/db.test.js` guards it.

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

**Writes** (slice 4) are `POST /api/findings/:id/confirm`, `POST /api/findings/confirm` (bulk,
`{ids}`), and `POST /api/findings/:id/skip`. All of them sit behind `server/writeGuard.js` and carry
a tighter rate limit than reads, because a confirm spends Wikimedia's API budget and not just ours.
`fetchFn` is threaded from `buildServer` down to `confirmFindings`, so the whole application can be
driven over an in-memory database with no network.

Everything about *why* the headers, limits and validation rules are what they are — including the
CSP hosts that are easy to get wrong, and what the write guard defends against — is in
[security.md](security.md).

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

### Verification (`lib/verify.js`, `verifyFindings.js`)

`verifyOpenFindings(store, {kind, limit, fetchFn})` re-checks open findings against the **Action API, never SPARQL** — WDQS lag would report an image still missing right after you added it, and a second one would go on. `fetchFn` is injectable, the repo's established seam for faking the network in tests.

Requests use `redirects=no`. That is the load-bearing simplification: the API then reports a redirect exactly like a deleted entity, so since merged and deleted both resolve to `gone`, a single `entity.missing` check covers both and no requested-vs-returned id comparison is needed. An entity absent from the response entirely is also treated as `gone`, so a finding can never get stuck open because the API stopped mentioning its item.

Results go through **`store.markVerified()`, never `recordFinding()`** — the latter overwrites `payload`, and with `payload` undefined it writes NULL, so reusing it here would wipe the stored draft wikitext of every finding the pass touched. `test/verify.test.js` guards exactly that.

### Batched entity fetches (`utils.fetchEntitiesBatched`)

One helper owns the `wbgetentities` ceiling of **50 ids per request** and the Wikimedia guidance of **≤3 concurrent requests** (the three call sites it replaced each used 4), plus retry via the shared `fetchWithRetry`. `sitefilter` and `languages` are parameters rather than constants because callers want different things — the ancestor walk needs `specieswiki`, verification needs `commonswiki`, place labels need `props=labels&languages=en` — and a single widened filter would make every batch carry payload most callers never read.

A well-formed but deleted or merged id returns per-entity `{id, missing: ''}`, so one bad id does not fail its batch. Only a *malformed* id (out of range) fails the whole request with `no-such-entity`; QIDs sourced from Wikidata cannot hit that.

**Known interim gap.** The report's done checkbox still writes `localStorage` (`done-<QID>`), which the checker cannot see, so ticking a row does not mark the finding `done` and it reappears in the next regenerated report. That mattered less when the report was a one-shot list; now that it is the persistent backlog it is visible. Slice 4 of [findings-db-roadmap.md](findings-db-roadmap.md) moves that state into the database.

## Vernacular name language codes (`lib/getInatNames.js`)

iNaturalist returns Chinese names under `zh-CN` and `zh-TW`. These are normalised to `zh-hans` and `zh-hant` respectively before comparison with Wikidata, because Wikidata uses lowercase script subtags for these languages.

## Genus-as-vernacular leak (`checkNames.js`)

iNaturalist sometimes stores the genus name itself as a vernacular name for a species in certain locales (e.g. `de:"Olyra"` for *Olyra longicaudata*). These pass through the scientific-name exclusion filter — which only strips the full binomial — unless explicitly checked. `checkNames.js` filters them by comparing each candidate name against the first word of the scientific name (`sciName.split(' ')[0]`).

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

## Taxonomy tree comparison and `--auto` certainty filter (`lib/utils.js`, `checkLinks.js`)

`compareAncestorTrees(wdChain, inatChain)` aligns the WD and iNat ancestor chains by rank name (case-insensitive), counts agreements and disagreements among labeled ranks present in **both** chains, and returns `{ matches, mismatches, matchedRanks }`. Only the 9 ranks in `WD_RANK_LABELS` can be labeled on the WD side (genus, family, superfamily, subfamily, tribe, subtribe, order, subclass, class); iNat rank strings are used as-is. Ranks present in only one chain are ignored — they do not count as mismatches.

The `--auto` certainty filter requires: `mismatches === 0 && matches >= 3 && (matchedRanks.includes('family') || matchedRanks.includes('order'))`. The family-or-order anchor prevents three coincidentally agreeing intermediate ranks (e.g. subfamily/tribe/subtribe within a split family) from triggering auto-approval on an actually wrong match.

**Known recurring disagreement — Noctuidae/Erebidae:** many moth genera were reclassified from Noctuidae to Erebidae; WD and iNat have not fully converged on this split. Affected genera produce a family-level mismatch for otherwise correct matches and correctly fail the auto-filter, appearing in `links.html` for human review.

---

## Wikidata QID reference

Most QIDs live in code constants; this is the human-readable map. **QIDs can change via item merges** — if rank or ancestor detection breaks unexpectedly, re-verify these against the live items.

**Taxon ranks** (`WD_RANK_LABELS` in `lib/utils.js`, `RANK_LABELS` in `lib/generateWikitext.js`): genus `Q34740`, family `Q35409`, superfamily `Q2136103`, subfamily `Q164280`, tribe `Q227936`, subtribe `Q3965313`, order `Q36602`, subclass `Q5867051`, class `Q37517`. "Instance of taxon" is `Q16521`.

**IUCN status (P141)** QIDs and their Commons categories: see the [IUCN Commons categories](#iucn-commons-categories) table above. Note EN is `Q96377276` (not `Q11394`).

**`{{IUCN}}` template logic** (`lib/generateWikitext.js`): when an item has both P627 (Red List numeric ID) and P141 (status), emit `{{IUCN|code|id|name|authority}}`, which auto-categorises the Commons page into the correct IUCN maintenance category. With P141 only (no P627), emit a manual `[[Category:IUCN X species]]` instead.

**Source item:** the iNaturalist Wikidata item `Q16958215` is used as the `S248` (stated in) source on generated P1843 vernacular-name references (`checkNames.js`).
