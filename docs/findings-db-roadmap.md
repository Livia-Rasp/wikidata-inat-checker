# Findings database roadmap

The plan for turning the checkers from one-shot report generators into a persistent, resumable
worklist served by a small backend. Written 2026-08-14; the decisions behind it are summarised
below, the ordered work is in [Slices](#slices).

**Status:** slices 0–5, 5b, 5c and 5d are shipped — the findings database, the verification pass,
the Fastify backend, the confirm-gated done state, on-demand scoped discovery, the scheduled
top-up, the backlog search and a container that runs. Remaining: 6 (app shell, area as a discovery
scope), 7–8 (the links and names checkers onto the findings table), 9 (deploying that container,
with backups) and 10 (making discovery reachable once it is deployed). Each slice ships as its own
pull request, and each records below what turned out differently from the plan — that is the part
worth reading.

Project-level context lives in the Obsidian vault (`Wikidata iNat Checker`); this file is the
implementation detail, and the **plan of record** for persistence, sequencing and the web app.
It absorbed `web-app-architecture.md`, a pre-Fastify planning document that had been overtaken on
almost every point; what survived of it is [Not scheduled](#not-scheduled) at the end.

## Why

*(The state of the repo when this was written. Slices 1 and 4 fixed it for the image checker; the
`cache/cache-*.json` files are still how names and links work, until slices 7 and 8.)*

The `cache/cache-*.json` files are tombstones, not caches: they record `inatId → date-checked` and
never the result. The results lived in `output/*.html` and `web/data/taxa.json`, overwritten
wholesale on every run. So **a second run destroyed the backlog from the first** — those taxa are
cached, therefore skipped forever, and what described them is gone. That is why a batch could not
be worked through at leisure, and it would get worse the moment anything ran on a schedule.

Separately, the "done" state lived in `localStorage` (`winc-uploaded`, `winc-p18` in
`web/js/cache.js`), keyed per browser profile, so the checkers could not see it and it died with
the profile.

## Decisions

- **The findings table is never meant to be complete.** Transferring everything iNat could give
  Wikidata in one go is far too much. The workflow is: fetch a batch, work through it, and when it
  is nearly done fetch more — untargeted, or scoped to a family, an IUCN status or an area.
  Discovery is a *user-triggered action with a scope*, not a schedule. This is why there is no TTL
  sweep, no daily budget scheduler and no revalidation cron in this plan.

  **Partly revisited 2026-08-15 (slice 5b).** A schedule is wanted after all, but for a different
  reason than the one rejected here: spreading outbound load onto quiet hours, and accumulating
  candidates over time so a work session does not have to start by waiting for a discovery run.
  On-demand discovery remains available; the schedule reuses its job runner and its single-flight
  lock.

  **Reversed again when 5b was actually built (2026-08-22).** The plan above still gated the
  scheduled run on the backlog being low. Livia overrode that: a bigger backlog does not hurt here
  — the whole workflow is "fetch a batch, work through it, fetch more", and there is no cost to
  fetching before the current batch is exhausted. So the shipped scheduler runs **once a day,
  unconditionally**, preferring a quiet hour but with a deadline catch-up that overrides quiet
  hours rather than let a whole day pass with no run. "The table is never meant to be complete"
  still holds — it just no longer implies a size gate. See slice 5b below for the rest.
- **SQLite, deliberately** — `journal_mode=WAL`, a `busy_timeout`, `STRICT` tables, one writer by
  discipline, `VACUUM INTO` for backup. Postgres was considered and rejected: it is more ops here,
  and the iNat taxa index stays SQLite regardless, so findings in Postgres would mean two engines
  with no join between them — while scoping a worklist to a family *is* that join. Revisit only if
  the CLI ever needs to run on another machine against the server's database, which SQLite cannot
  do over a network filesystem.
- **Driver: the built-in `node:sqlite`**, migrated in slice 0, which is why `engines` is `>=26`.
  The project now has no native build step and no SQLite dependency at all.
- **Fastify backend.** The spin-out of `web/` is theoretical, so the static, backend-free property
  protecting it is not worth paying for.
- **Verification uses the Action API, never SPARQL.** WDQS is an eventually-consistent index whose
  lag is usually seconds and occasionally hours, and it fails in the worst way here: straight after
  a QuickStatements batch it may not show the edit yet, so a re-check would report the image still
  missing and a second one would be added. `wbgetentities` reads the live database, takes 50 QIDs
  per call, and `fetchEntities` in `lib/generateWikitext.js` is already it — it fetches
  `props=claims|sitelinks` and simply never reads P18. **SPARQL for discovery** (bulk, approximate,
  a snapshot is fine); **Action API for verification** (authoritative, at the moment of truth).
- **Nothing is marked done until the edit is confirmed live.** Uploads and QuickStatements stay
  manual at first, so the app cannot know an edit landed — it has to look. Confirmation runs right
  after the action, against the Action API; a finding that fails to confirm simply stays `open`.
  There is no intermediate "emitted" state.
- **Three finding kinds: `image`, `name`, `link`.** Area is not a fourth — `checkArea.js` step 1
  finds species observed near a point and step 2 asks which have P3151 but no P18, which is the
  image checker's question with a geographic scope. So `--taxon`, `--iucn` and
  `--lat`/`--lng`/`--radius` are three scopes on one discovery. Area still earns its own subpage,
  because its per-taxon photo and latest-observation enrichment is genuinely different.
- **One checker migrates at a time, each getting its own subpage.** The app stays multi-page and
  Fastify-served rather than gaining a client router — "no build step" is a property of this repo
  worth defending for four mostly-static views.
- **OAuth is out of this plan entirely** (2026-08-16), not merely last. It is not part of the initial
  deployment: the tool should be run by hand first and its bugs found while an edit can still do
  nothing. See [Beyond the plan](#beyond-the-plan-oauth-upload-and-direct-editing). Each of the three
  apps (this, `commons-describe-upload-toolbox`, `vue-commons-gallery`) registers its own token when
  the time comes; the toolbox's logic is a model to orient on, not a dependency to wait for.

## Schema (v1)

Timestamps are ISO-8601 `TEXT` because `STRICT` tables allow only `INT`/`INTEGER`/`REAL`/`TEXT`/
`BLOB`/`ANY`. Schema version is tracked in `PRAGMA user_version`.

```sql
CREATE TABLE taxa (
    qid        TEXT PRIMARY KEY,
    inat_id    TEXT,
    taxon_name TEXT,
    rank       TEXT,
    iucn       TEXT,
    first_seen TEXT NOT NULL
) STRICT;

CREATE TABLE findings (
    id            INTEGER PRIMARY KEY,
    qid           TEXT NOT NULL REFERENCES taxa(qid),
    kind          TEXT NOT NULL,   -- image | name | link
    payload       TEXT,            -- JSON, kind-specific (draft wikitext, missing languages, …)
    status        TEXT NOT NULL,   -- open | no_photos | no_draft | done | skipped | fixed_upstream | gone
    discovered_at TEXT NOT NULL,
    checked_at    TEXT NOT NULL,   -- last time the source was asked; drives negative-result expiry
    verified_at   TEXT,
    resolved_at   TEXT,
    resolution    TEXT,            -- JSON: what was done; later carries an edit/revision id
    UNIQUE (qid, kind)
) STRICT;

CREATE INDEX idx_findings_worklist ON findings(kind, status);

CREATE TABLE runs (
    id          INTEGER PRIMARY KEY,
    tool        TEXT NOT NULL,
    scope       TEXT,              -- JSON: taxon / iucn / area / limit
    started_at  TEXT NOT NULL,
    finished_at TEXT,
    n_scanned   INTEGER,
    n_found     INTEGER
) STRICT;
```

`resolution` is written from the first slice onward even while edits are manual, so the OAuth work
adds an edit id to an existing column rather than migrating the schema.

**Do not delete resolved rows.** Discovery skips a taxon because a row exists for it; delete the row
and the next top-up resurfaces it. Pruning `done` findings would require keeping a minimal
`(qid, kind)` tombstone — which is exactly the design being replaced. The rows are small; keep them.

### Negative results expire; positive ones do not

`no_photos` and `no_draft` are **observations with a shelf life, not verdicts**. CC-licensed photos
keep being uploaded to iNat, new P3151 links keep appearing, and someone eventually adds the missing
P225 — so a taxon written off today is a genuine candidate again in a few months. Recording a
negative without a date would rebuild the exact defect this whole plan exists to remove, only
slower. Hence `checked_at`, and a skip test of:

- an actionable row (`open` / `done` / `skipped`) → always skip
- a negative row (`no_photos` / `no_draft`) → skip **only while `checked_at` is inside the recheck
  window** (`--recheck-after`, default 90 days); otherwise the taxon is a candidate again
- no row → candidate

A re-check upserts the `(qid, kind)` row in place — the status may flip `no_photos` → `open` — and
refreshes `checked_at`. This is *not* the TTL sweep rejected above: there is no scheduler and no
background job. Rows simply become eligible again, and are only ever looked at when discovery next
runs, under the same `--limit`.

## Slices

Each slice is a vertical increment that leaves the repo working, tested and committable. Docs
(`CLAUDE.md`, `README.md`, the relevant `docs/*.md`) are updated as part of the slice that changes
behaviour, not batched at the end.

### 0. `node:sqlite` + Node 26 — **done**
Swapped `better-sqlite3` for the built-in `node:sqlite` before any schema work, so the findings
store is designed against a driver already known good. Mechanical, gated by the existing suite.
`lib/getInatTaxaDb.js` and its test, `package.json` (dependency and `allowScripts` both dropped,
`engines` `>=20` → `>=26`), `.github/workflows/ci.yml`, and a new `.nvmrc`. The four API
differences that bit are written up in [dev.md](dev.md#driver-nodesqlite-not-better-sqlite3).

Verified: 25/25 unit tests, and a real index build — 1,418,443 active taxa in 12.4 s, with every
accessor returning the right types.

### 1. Findings store replaces the images tombstone cache — **done**
No backend yet. Adds `lib/db.js` (open + PRAGMAs + schema v1 + a `user_version` migration runner),
writes `checkImages.js` results into `taxa`/`findings` instead of `cache/cache-images.json`, and
makes the HTML report and `web/data/taxa.json` render *from the DB*.

**Working means:** run the image checker twice and the backlog accumulates instead of being
destroyed — `taxa.json` exports every open finding, not just the last batch. Unit tests cover the
schema and the accessor against an in-memory SQLite fixture, the pattern `test/` already uses for
the taxa accessor.

Optional and small: import an existing `cache-images.json` as rows with a `legacy_checked` status so
previously-checked taxa do not resurface. The tombstone cannot say *what* was found, so that is the
honest ceiling.

**Not in this slice:** verification, any backend.

**Verified.** 35/35 unit tests, and four real runs from a scratch directory: a repeat of the same
command skipped all 20 already-recorded taxa and found 20 different ones, then a run under a
*different* IUCN filter left the report holding the earlier three findings **plus** the new one
(Q136084/Q143300/Q587982 → those three plus Q428420). Under the old code that fourth run would have
produced a report containing only Q428420 and destroyed the rest.

**One addition beyond the plan.** `drafts.html` gained an IUCN column, using the Red List's own
category colours. It is not decoration: the backlog now mixes categories from different runs, so
without it there is no way to tell what a row is or what to prioritise — a gap created by
accumulation itself. `iucn` rides along into `web/data/taxa.json` too, for the app to subselect on
later.

**Known interim gap.** The report's done checkbox still writes `localStorage`, invisible to the
checker, so a ticked row stays `open` and returns in the next regenerated report. Slice 4 fixes it.
Worth naming because this slice makes it far more noticeable than it was.

### 2. Verification pass — **done**
Adds `lib/verify.js` and a `verifyFindings.js` entry script (`npm run verify`): findings whose P18
appeared meanwhile become `fixed_upstream` (recording the filename), merged or deleted items become
`gone`, the rest stay `open` with `verified_at` refreshed, and the reports are re-rendered so they
stop offering work already done.

Two things turned out differently from this plan:

- **The redirect comparison was unnecessary.** Because merged and deleted both resolve to `gone`,
  passing `redirects=no` makes the API report a redirect exactly like a deleted entity, so one
  `missing` check covers both and no requested-vs-returned id logic exists. The cost, accepted: the
  record does not say which happened or where a merged item went.
- **Widening the shared `fetchEntities` sitefilter would have been a mistake** — that call is shared
  with the ancestor walk and `checkNames`, so every ancestor batch would carry sitelink payload it
  never reads. Instead `sitefilter` became a parameter of a new `utils.fetchEntitiesBatched`, which
  also absorbed the three copies of the `chunk(50)` + `pLimit` + `Promise.all` idiom and dropped
  concurrency 4 → 3, the documented ceiling.

The landmine avoided: `recordFinding` overwrites `payload`, so reusing it to flip a status would
have wiped the stored draft wikitext of every finding verified. Hence `markVerified`, and a test for
it specifically.

**Verified.** 44/44 unit tests, plus a live run seeding Q140 (has P18 → `fixed_upstream`, recorded
`Lion in masai mara.jpg`) and Q999999999 (absent → `gone`) alongside four genuinely open findings,
which stayed open with `verified_at` stamped. A second pass re-fetched only the four, and every
payload survived.

**Not in this slice:** confirmation of my own edits (that needs the write path in slice 4).

### 3. Fastify serves the images app from the DB — **done**
`server/` — Fastify serving `web/` plus a read-only `GET /api/findings`, with `web/js/main.js`
fetching it instead of `web/data/taxa.json`, and `npm run web` starting it. `web/serve.js` is gone.
The `taxa.json` exporter still runs but nothing reads it; removing it is slice 4's cleanup.

Folding this into slice 4 was considered and rejected (2026-08-14): it would produce a single commit
that changes where the data comes from *and* introduces the first write path, which is exactly the
shape that is miserable to bisect when the app later shows the wrong rows. Keep them separate.

Four things turned out differently from the plan, all because this is the slice that makes the
project a *service*:

- **Two latent `lib/db.js` bugs became reachable and had to be fixed first.** Until now exactly one
  process ever opened the database. `busy_timeout` was set *after* `journal_mode = WAL`, and the WAL
  switch itself takes a brief exclusive lock — so that line failed outright with `SQLITE_BUSY`
  whenever a checker was mid-write. And `migrate()` read `user_version` outside a *deferred*
  transaction, so two processes opening a fresh database both saw 0, both began, and the loser died
  on `table taxa already exists`. Now `BEGIN IMMEDIATE` with the version re-read inside the lock.
- **The API was hardened in its first commit, not a follow-up.** An intermediate commit with no CSP,
  no rate limit and a leaking error handler is not a state worth being able to bisect to. The
  threat model, and more usefully the list of what is deliberately *not* done, is the new
  [threat-model.md](threat-model.md) — which **slice 4 must re-read**, because "it only reads public data"
  stops being true at the first write endpoint.
- **The CSP forced a small `web/` refactor.** helmet's default `script-src-attr 'none'` blocks
  event-handler attributes, and the app had three (`onclick`/`onchange`) plus three `window.*`
  globals existing only to serve them. They became delegated listeners on `#tbody` — worth doing
  regardless, since that table is built from database content with `innerHTML`.
- **The page-size cap lives in the route schema, not the store.** A default `limit` on
  `listFindings` would have silently truncated `drafts.html` and `taxa.json`, which render the whole
  backlog — a data-loss bug wearing a display bug's clothes. The response therefore carries `total`
  alongside `count`, so a truncated page cannot present itself as the complete worklist.

The row contract gained `id` and `status` **now**, so slice 4's `POST /api/findings/:id/confirm`
does not have to change the read contract and add the first write path in one commit.

**Verified.** 74/74 unit tests, including negative ones that matter more than the happy path: an
internal error whose message contains the database path answers with none of it; `?unknown=1` and
`?limit=999999` are 400s rather than silently-defaulted queries; ten consecutive asset requests do
not trip the API's rate limit (the failure `vue-commons-gallery` documented); `/data/` and dotfiles
are not served; `/nope.html` 404s instead of falling back to the index.

### 4. Confirm-gated done state in the DB — **done**
`POST /api/findings/:id/confirm` (plus a bulk `POST /api/findings/confirm`) and
`POST /api/findings/:id/skip`; the uploads and P18 picks in the database; a one-time importer for
what a browser profile still holds; and `report/generateImagesJson.js` deleted.

The plan understated the problem. It described moving the done state, but the flow itself was
inverted: picking a photo wrote `done-<qid>` immediately, and **Copy & clear deleted the pick** — so
the app recorded that work was finished while destroying the record of what the work was, with no
evidence anyone had pasted the batch. Picking now records an *intention*; only Wikidata can turn it
into `done`.

Five things worth keeping:

- **Confirmation requires both statements**, P18 *and* the commonswiki sitelink — chosen over the
  simpler P18-alone test, which was the recommendation at the time. It costs nothing (slice 2
  already fetched `sitefilter=commonswiki` and never read it) and it catches the half-applied
  batch, which is a real failure mode. The objection against it — a taxon that will never have a
  Commons category sits open looking like a failure — is answered by the response naming *which*
  half is missing, and by `skip`.
- **This makes confirm and verify disagree, deliberately.** Verify still resolves on P18 alone,
  because it asks "does this still need an image?". Written up in [dev.md](dev.md) so it does not
  read as a bug later.
- **The security gate was met by enforcing the loopback bind**, not by adding auth: the server now
  refuses to start bound elsewhere without `ALLOW_REMOTE_WRITES`. A shared token was rejected as the
  wrong shape — a static app cannot hold a secret, and a per-deployment token is not the per-user
  identity OAuth needs. What did get built is `server/writeGuard.js` (Host allowlist against DNS
  rebinding, fetch-metadata CSRF checks, JSON-only bodies), because a loopback bind is not a defence
  on its own.
- **Two `lib/db.js` details paid for themselves:** `getFinding(id)` (the write endpoints address
  findings by id while every write statement is keyed on `(qid, kind)`, and `markVerified` silently
  updates zero rows — so without it a bad id looked like a successful confirm), and `markSkipped`,
  which does *not* stamp `verified_at` because a skip never asked Wikidata anything.
- **The importer does not import "done".** That flag was written when a QuickStatements line was
  copied; taking it as truth would have reproduced the exact defect being removed. Locally-done taxa
  come back as ids to confirm.

**Verified.** 117 unit tests, including the write guard re-run against `GET` to prove reads are
untouched, and error sanitisation. Against live Wikidata: a genuinely image-less taxon answered
`missing_p18_and_sitelink` and stayed open; `Larix mastersiana`, which already has a Commons
category but no image, answered `missing_p18` — the discrimination the strict gate buys; and a
seeded Q140 confirmed with the real filename and category, left the backlog and spent its pick.
In the browser: the import moved two files and one pick, left another report's `done-links-*` key
alone, confirmed 0 of 1 previously-"done" taxa, and picking a photo recorded the pick without
marking anything done.

**Not in this slice:** discovery from the UI.

### 5. On-demand scoped discovery from the app — **done**
`lib/discover.js` extracted from `checkImages.js` (now a thin CLI wrapper), `POST /api/discover`
with a polled status endpoint and a cancel, and a scope form in the app. Runs happen in a **forked
child**, which the plan did not call for and the measurements demanded: `allInatIds()` is 1.4M rows,
~1.0 s of blocked event loop and a ~650 MB heap spike, and `node:sqlite` is synchronous throughout,
so an in-process run would freeze the API for a second at a time and keep the memory.

Five things worth carrying forward:

- **The pipeline had to be inverted before it could be exposed.** `checkImages.js` recorded nothing
  until every HTTP call was done, so a run that was killed or cancelled had nothing to show for the
  API budget it had already spent. Findings are now written per iNat batch, which is what makes
  progress real and `cancel` mean "stop here, keep what is done".
- **`process.exit(1)` on bad input was the highest-severity finding of the pre-exposure review.**
  An unknown taxon
  or IUCN code killed the process; over HTTP that is an unauthenticated remote kill. Those are typed
  errors now, resolved *before* the run row is opened so a rejected scope leaves no trace.
- **The server must never build the taxa index.** `loadTaxaDb()` downloads 189 MB and rebuilds on a
  30-day-old cache. Split into `ensureTaxaDb()` (CLI) and `openTaxaDb()` (server, throws instead) —
  two functions rather than a boolean the server could pass wrong.
- **Privilege is checked on the peer address, not `Host`.** `curl -H 'Host: localhost'` forges the
  header from anywhere, so the Host allowlist stops DNS rebinding and nothing else. Discovery is
  loopback-only *and* off unless `DISCOVER_ENABLED`, because it spends the operator's Wikimedia and
  iNaturalist reputation and the read view is meant to go public.
- **The trap held:** top-up excludes findings of every status, not just `open`, so nothing
  deliberately skipped comes back. `test/discover.test.js` pins it.

**Verified.** 181 unit tests, the job state machine driven through every lifecycle path against a
fake spawn. Live: a 400-taxon Orchidaceae run over HTTP (116 open), a 900-taxon run cancelled
mid-flight keeping its completed batches, a stale run id refused, and `kill -9` on the parent
leaving no orphan (child 456050 died with parent 456032).

**Known rough edge, fixed in 5c:** the scope form fetches into the list rather than filtering it, so
searching for a clade shows the whole backlog with the new taxa mixed in.

### 5c. A search page over the backlog — **done**
Added 2026-08-16, from using slice 5: the scope form asks for a taxon and then shows the *whole*
backlog with the new taxa mixed in, so there is no way to look at just the orchids you went and
fetched. Searching and fetching were conflated into one box that only did the fetching half.

- **Its own page** (`web/search.html`), not a control bolted onto the list. Searching is a read —
  instant, free, and nothing to do with spending API budget. This is also the second page that makes
  slice 6's app shell worth building, so the two are natural neighbours; after searching you land
  back on the normal list.
- **One box filters and scopes**, for taxon and IUCN alike: type `Orchidaceae`, see orchids, and a
  top-up from there fetches more of the same. The server resolves the clade through the taxa index
  and filters findings by descendant iNat ids, caching the descendant set per taxon — the scan is
  ~0.5 s for a large clade, so only the first search of one should pay for it.
- **Offer, never act.** Thin results prompt ("12 orchids in the backlog. Find more?") and start a
  scoped discovery *only if clicked*. A typo or an idle browse must never turn into minutes of
  Wikimedia and iNaturalist traffic.

**One decision was reversed in the build: filtering walks *up* the tree, not down.** This slice
specified `descendantInatIds` plus a per-taxon cache; measured, that is 452 ms and 21,973 ids for
Orchidaceae — an unindexed scan of 3M rows whatever the clade size, on a synchronous driver, in the
process slice 5 forked a child to keep free. Reading each *backlog* row's ancestry instead is 4.9 ms
cold and 0.14 ms warm, and the memo warms over the backlog rather than per clade searched. Written
up in [dev.md](dev.md#searching-the-backlog-libbacklogindexjs).

Four more things turned out differently, all found by using it rather than by testing it:

- **A missing taxa index degrades instead of 503ing.** Discovery cannot run without the index;
  search can still match the names the findings database holds. The read surface is the part meant
  to go public, so it must not be takeable down by a file in `~/.cache`.
- **Ambiguous names are the common case, not an edge one.** `Bulbophyllum` is a genus *and* a
  section; `Iris` is four taxa. The disambiguation prompt earns its place on the first real search.
- **Suggestions rank by taxonomic rank, not ancestry depth.** Depth was the vocabulary-free proxy
  and it does not work — lineages differ wildly in how many intermediate ranks they carry, so `Orch`
  answered *Orchesellaria* before *Orchidaceae*. A misspelling also needs a **shorter** prefix to
  fall back to, because typos land at the end of the word, which is exactly where a prefix search
  gives up.
- **The row list must not be cached.** Caching it and invalidating on run completion misses skips
  and confirms, which settle findings with no run involved — so the page offered work already done.

**Verified.** 209 unit tests, and in Chrome against a real 153-finding backlog: the full loop
(2 findings in Cypripedioideae → Find more → 5, staying on the query rather than reloading),
widening and narrowing through the rail and the composition strip with Back undoing each step,
clade and status composing, keyboard order with a visible focus ring, 420 px wide without the page
scrolling sideways, and — from the server log — **zero POSTs** across nine searches over five clades.

### 5d. A container that runs — **done**
Added 2026-08-19, splitting the dockerisation in two. Slice 9 bundled "runs in a container" with
"is deployed from a registry and backed up", and those are different problems: the first is about
the runtime — does this thing start, find its database and serve — while the second is pipeline
and operations. Doing the runtime half early de-risks the other half, because the volume and
configuration questions get answered while they are still cheap to get wrong.

Deliberately small. A `Dockerfile` and a compose file; the findings database on a mounted volume;
`HOST`, `PORT` and `TRUST_PROXY` set correctly for a container, which is exactly the configuration
[threat-model.md](threat-model.md) warns about — binding beyond loopback needs `ALLOW_REMOTE_WRITES`
*and* `ALLOWED_HOSTS`, or every write is refused by the Host allowlist under a name that is not
`localhost`.

**Explicitly not here:** GHCR, watchtower, automated redeploys, the backup timer. Those stay in
slice 9. This slice ends at `docker compose up` giving you a working app against a persistent
volume.

Two things to get right, because they are the ones a naive image gets wrong:

- **The taxa index is not in the image.** It is ~236 MB, derived, and rebuilt from a 189 MB
  download — so it belongs on a volume alongside the findings database, not baked into a layer.
  The server refuses to build it anyway (`openTaxaDb()` throws where the CLI's `ensureTaxaDb()`
  downloads), so a container without it must degrade rather than fail: search says `degraded: true`
  and discovery is unavailable. Worth confirming that is what actually happens.
- **Discovery forks a child**, which needs the image to have a working `process.execPath` and
  enough memory for a ~650 MB heap spike. A container memory limit set below that turns a
  discovery run into an OOM kill — and `SIGKILL` is deliberately never reported as a cancel, so it
  would surface as a mystery.

**Working means:** `docker compose up`, open the worklist, confirm a finding, restart the
container, and the confirmation is still there.

Five things turned out differently, three of them decisions and two of them discoveries:

- **A bind mount of `./data`, not a named volume.** The named volume is the conventional deployed
  shape, but it puts the database somewhere the host's checkers cannot reach — and the checkers are
  how the backlog gets filled, since only the CLI may build the taxa index. A bind mount makes the
  server and the CLI two processes over one file, which is exactly what `openFindingsDb` was
  written for. Verified live: a host process wrote while the container held the database open, and
  the running container saw the change with no restart. The host's uid/gid is 1000, which matches
  the `node` user in the official images, so no `chown` and no `chmod 777`.
- **Discovery is unreachable from the host browser, which is narrower than it first looked — and
  the difference is a trap.** The privileged routes check the raw TCP peer address, which through
  a published port is the bridge gateway, so **Find more** answers 403 `not_local` even with
  `DISCOVER_ENABLED=1`. The first version of this note concluded that discovery therefore "cannot
  run in a container" and sized `mem_limit` at 512m on that basis. **Wrong**: from inside the
  container the peer really is loopback, and `docker compose exec` posting to `127.0.0.1:8080` is
  accepted with 202 — verified. It only dies immediately because the taxa index is absent from the
  image. Mount that index one day and the ~650 MB fork happens, at which point a 512m cap
  OOM-kills it and `SIGKILL` is never reported as a cancel. `mem_limit` is 1500m, sized for the
  spike rather than for today's accident.
- **Publishing to GHCR came along for the ride**, pulled forward out of slice 9 because it turned
  out to be about fifteen lines and no secrets — `GITHUB_TOKEN` can push to the repository's own
  namespace. The trap, caught before it shipped: `github.repository_owner` is `Livia-Rasp`, and
  registry paths must be lowercase, so interpolating it raw fails with "repository name must be
  lowercase" — at push time, after the build and smoke test have passed. It is lowercased in the
  workflow.
- **The BuildKit cache mount needs `buildx` present**, which the build machine initially lacked —
  the Dockerfile did not build at all, since `--mount=type=cache` is BuildKit-only syntax and
  `DOCKER_BUILDKIT=0` is therefore not a fallback. Installing buildx was the fix; worth knowing
  that this one line is what makes the plugin a hard requirement rather than a nicety.
- **`read_only: true` works**, because no route touches the filesystem — every write endpoint is
  SQL only. The container runs with a read-only root, a tmpfs `/tmp`, and the bind mount as the
  single writable path.
- **CI caught a portability bug that local verification could not, and the reason is worth
  keeping.** Every check passed on the development machine because that user's uid is 1000, which
  is also the `node` user in the official images — so the bind mount happened to be writable by
  coincidence. On a GitHub runner (uid 1001) the container exited 1 with "unable to open database
  file" before serving anything, and the README was at that moment telling every reader whose uid
  is not 1000 to do exactly that. A bind mount keeps host ownership; only a *named volume* gets
  chowned by Docker on first use. The container now takes `WINC_UID`/`WINC_GID`, and CI runs as
  the runner rather than as `node`, so the mismatch is exercised rather than accidentally avoided.
  The `ENV HOME` added earlier as belt-and-braces turned out to be what makes this possible: a uid
  with no passwd entry resolves `os.homedir()` from `$HOME` instead of throwing.
- **The keep-alive shutdown trap does not apply.** The usual failure — idle sockets holding
  `server.close()` open until the grace period expires — is pre-empted by Fastify 5 defaulting
  `forceCloseConnections` to `"idle"`. Measured: `docker stop` returns in 0.19 s with exit code 0,
  not 137.

**Verified.** The whole list above against a `VACUUM INTO` copy of a real 156-finding backlog:
the worklist rendering, a write succeeding through the published port (the write-guard trap), a
skip surviving a container restart, search degrading rather than 503ing with no taxa index,
discovery refusing with `not_local`, and a clean stop. Then `docker compose up` against the real
database as the final check.

### 5b. Scheduled top-up — **done**
Added 2026-08-15, after the "no schedule" decision above was revisited; built 2026-08-22. Sequenced
**after** slice 5, which built everything it needs: the child-process job runner, the single-flight
lock, the status record and the outbound caps. This slice is the trigger and the condition, nothing
else. `server/scheduledTopup.js`, a `runs.triggered_by` column and a `request_log` table (schema
v4), wired into `buildServer()` and gated by `TOPUP_*` env vars — full table in
[threat-model.md](threat-model.md).

Decisions that held from the plan:

- **Off unless configured, with one fixed scope from the environment**, and requiring
  `DISCOVER_ENABLED` too — a scheduled run spends the same budget an on-demand one does.
- **Reuses the on-demand job runner and its single-flight lock**, and does so by calling
  `jobs.start()` **in-process**, never over HTTP — which turned out to mean it needs no privilege
  mechanism of its own at all: the loopback-peer check in `server/writeGuard.js` only ever applies
  to an actual HTTP request, and there isn't one. Written up in
  [threat-model.md](threat-model.md#the-scheduled-top-up-slice-5b--why-it-needs-none-of-the-above).
- **Timing is adaptive on measured request volume**, the harder option this plan flagged as
  "recommended against... a fixed hour is the fallback if the signal proves too noisy." Livia chose
  to build it anyway. `request_log` holds one row per UTC hour bucket, upserted on every `/api/*`
  request except discovery's own traffic (which would otherwise bias the very signal it feeds);
  `store.quietHoursOfDay()` averages it per hour-of-day over a rolling window and returns the
  quietest N hours. The hysteresis the plan asked for is a 24h cache on that computation, not a
  per-tick recompute — a single noisy hour cannot flip the eligible set tick to tick.

Two things turned out differently, both decided during the build rather than left to guesswork:

- **The backlog-size gate was dropped entirely.** The plan above said "only when the backlog is
  below a threshold." Livia overruled it: a bigger backlog does not hurt — the workflow is fetch a
  batch, work through it, fetch more, and there is no cost to fetching before the last batch is
  gone. The shipped rule is **once a day, unconditionally**, preferring a quiet hour but with a
  `TOPUP_DAILY_DEADLINE_HOUR` catch-up that overrides quiet hours rather than let a whole day pass
  with no run — because the server might be down through every quiet hour, or the derived set might
  simply be wrong yet. "The findings table is never meant to be complete" survives this change; it
  just no longer implies a size gate.
- **The daily-once gate has a documented blind spot.** It reads `runs.triggered_by`, and `discover()`
  deliberately opens no run row until a scope is resolved — "a bad scope leaves no trace of a run"
  predates this slice. But `openTaxaDb()` throws even earlier than that, inside
  `discoverChild.js`, before `discover()` is ever reached — so a *missing taxa index* leaves no run
  row either, and the scheduler retries it every `TOPUP_CHECK_INTERVAL_MINUTES` instead of once a
  day until the index exists. Accepted rather than fixed: the failure is cheap (a fork that dies
  before the ~650MB taxa load, no Wikimedia or iNaturalist request spent), it self-heals the moment
  the index is built, and the documented deployment order already builds the index before
  `TOPUP_ENABLED` is ever set.

**Working means:** a machine left running accumulates candidates on its own, and a work session
starts with a backlog already there.

**Verified.** 250 unit tests, including `evaluateTopup`'s decision table exercised directly (no
timers, no DB) and `createScheduledTopup`'s wiring driven by a captured interval callback. Live,
from a scratch copy of the real database: a run fired within a minute of the process starting
(bootstrap path — no request history yet, so every hour was eligible), wrote findings, and recorded
`triggeredBy: "schedule"`; a second tick the same "day" correctly answered `ran_today` and started
nothing; ordinary `/api/findings` traffic accumulated in `request_log` while polling
`/api/discover/status` and starting a run did not; and shutdown stayed clean (the interval is
`unref()`'d and explicitly stopped in `onClose`, before the store closes). Against the real
container image, both without and with the taxa index mounted: the missing-index case degraded
exactly as described above rather than crashing the container, and with the index mounted a
scheduled run completed end to end and `docker stop` exited in 0.15s.

### 6. App shell, plus area as a discovery scope
Introduces the multi-page shell and navigation (the first slice with a second page to justify it),
folds `checkArea.js` in as a third discovery scope writing `kind=image` findings, and gives it an
`/area` subpage carrying the photo and latest-observation enrichment.

Fix the known enrichment gap here rather than separately: the per-taxon photo/date lookup queries 20
taxa against one shared result window, so a few dominant taxa starve the rest and up to 19 per batch
come back with a blank date. Taxa are not dropped, only their enrichment. Confirm it still
reproduces first — it was noted 2026-07-02 and has not been re-verified.

**Working means:** the area checker is part of the app, and the `TODO(area-enrichment)` comment and
the "Known limitation" section in `docs/area.md` are gone. (The stale "How it works" and layout
table in that doc — which described neither the latest-date column nor the real sort order — were
fixed separately on 2026-08-19, so only the enrichment gap itself is left.)

**What the shell has to be, decided 2026-08-16 while building 5c** — three requirements that turn
"navigation" from a nav bar into a real piece of design, and that slices 7 and 8 then inherit rather
than each inventing:

- **A place to choose which checker to run.** Images, links, names and area are four workflows over
  one database, and there is currently no page whose job is picking between them. Not a start page
  you pass through once: it is where a session begins, so it should say what each one currently has
  open — the counts are one `statusCounts(kind)` per kind.
- **Switching workflow from inside one**, never by going back to a start page. Whatever the shell
  is, it stays present on every subpage, so `/links` is one control away from `/names`.
- **Each kind gets the same search page**, not a bespoke one. `GET /api/search` is already
  kind-agnostic apart from its default (`createBacklogIndex` takes `kind`), and clade and IUCN mean
  the same thing for a link finding as for an image one — so 5c's page becomes `?kind=link` with a
  different row renderer, and `web/js/rows.js` grows a per-kind row rather than being copied.
- **A dark/light toggle**, as `vue-commons-gallery`, the blog and `commons-describe-upload-toolbox`
  all have. Deliberately *not* done in 5c: one page dressed differently from the rest reads as a
  bug, so this is worth doing once, in the shell, for every page at once. Slice 5c laid the
  groundwork by moving the palette into `:root` custom properties in `web/css/styles.css` — a theme
  is then a second block, not a rewrite. The remaining literals in that file are what has to be
  tokenised first.
- **Links and names need the background runner too.** Discovery is `kind=image`-only today
  (`lib/discover.js` hardcodes `KIND`); slices 7 and 8 each need their own run to be startable from
  the app, through the same forked child, the same single-flight lock and the same status polling.
  That is one runner taking a `tool` argument, not three runners — `runs.tool` already records which.

### 7. Links checker → `kind=link` and a `/links` subpage
Migrates `checkLinks.js` onto the findings table with P3151 as the verification predicate, keeping
the `--auto` QuickStatements output. Simplest payload of the three, so it is the right one to prove
the schema really is multi-kind before the more complex names data lands.

`checkLinksStats.js` keeps working off the same tables.

### 8. Names checker → `kind=name` and a `/names` subpage
Migrates `checkNames.js`. Verification is per-language: P1843 must not already carry a name in the
language the finding proposes.

### 9. Deploy that container, with backups
**Scope narrowed 2026-08-19**, now that slice 5d builds the image and proves it runs. What is left
here is everything *around* the container rather than the container itself: publishing it, getting
it onto the home server, and keeping the database safe once it lives there.

- **~~Registry~~ — done early, in 5d.** Publishing turned out to be far smaller than the rest of
  this slice, so it was not worth deferring: `GITHUB_TOKEN` can push to the repository's own GHCR
  namespace, so there is no PAT to create and no secret to rotate. CI builds, smoke-tests and then
  pushes `latest` plus the commit sha, from pushes to `main` only. Build and publish are one job
  deliberately — it publishes the image that just passed rather than a rebuild presumed identical.
  Runs on a GitHub-hosted runner, never a self-hosted one: a persistent Docker-socket-privileged CI
  agent is a real liability on a box meant to run production services.
  **One manual step remains and is not automatable:** GHCR packages are private by default even
  from a public repository, so the package's visibility has to be switched to public once, by hand,
  in its settings. Until then `docker pull` needs authentication.
- **Redeploy.** Still here: `nicholas-fedor/watchtower` on the host polling GHCR. The pipeline
  shape to copy is `docs/deployment-roadmap.md` in the `vue-commons-gallery` repo.
- **Backups.** `VACUUM INTO` on a timer. The database is gitignored, so nothing else is protecting
  it, and by then it represents days of API budget. Note the server's connection is bound to the
  file it opened: **restoring a backup requires a restart**, or it keeps serving the old database.
- **`TRUST_PROXY` once something fronts it** — see [threat-model.md](threat-model.md) for why
  trusting `X-Forwarded-For` unconditionally makes the rate limiter bypassable, and why leaving it
  off behind a real proxy collapses every client into one bucket.

Sequenced before OAuth on purpose, accepting that the deployment will need revisiting for secret
handling once tokens exist — getting the tool onto the home server earlier is worth one redeploy.

### 10. Discovery reachable from a deployed container

Slices 5 and 5b are how the backlog gets fed — on-demand from the app, or automatically once it
runs low. Both are `privileged: true` routes gated on the loopback peer check in
[threat-model.md](threat-model.md#privileged-routes--discovery), and slice 5d proved that check is
not merely inconvenient behind a published port, it is structurally unreachable there: Docker's NAT
means the peer address the server sees is always the bridge gateway, never `127.x`, so **neither
on-demand nor scheduled discovery can be triggered from outside the container's own network
namespace.** A container deployed by slice 9 can only ever serve the backlog it shipped with — after
that it is a read-only demo, not a worklist, until someone `docker compose exec`s in by hand.

**Scope: replace or supplement the loopback check with something that survives NAT**, without
turning the two most expensive routes on the server into something an internet caller can trigger.
The risk being defended is the same one threat-model.md already states for these routes — spending
the operator's Wikidata/iNaturalist API budget, and later an OAuth grant, not data exposure — so
whatever mechanism ships has to keep that property: unforgeable by a caller who is merely on the
same network as the published port, and not dependent on a header a proxy could rewrite (the same
reason `TRUST_PROXY` does not already fix this).

**Deliberately not designed yet.** This slice is sequenced so it exists on the plan, not because the
mechanism is decided — that is real design work, to be done when the deployment in slice 9 is
otherwise in place and this is the thing actually blocking it. Candidates to weigh at that point,
none chosen: a bearer token set via environment variable and checked on the privileged routes only;
putting the check behind whatever credential OAuth eventually introduces instead of inventing a
second scheme; a network-level answer (a VPN or Tailscale hop that makes the caller genuinely local
again) that needs no change to the server at all. Whichever it is, it should get its own writeup in
threat-model.md next to the loopback check it replaces or narrows.

**Working means:** a discovery run — on-demand or 5b's scheduled top-up — can be triggered against
the container from wherever slice 9 puts it, without the privileged routes becoming reachable by
anyone who can merely reach the published port.

The ordered plan ends here. Slice 10 is the last thing needed for a deployed instance to stay
usable rather than draining to a fixed backlog; what follows is deliberately outside it.

## Known: `skipped` does not survive more than one user

Raised 2026-08-16. `Skip` writes `status = 'skipped'` on the finding itself, and `skipped` is a
sticky status — `skipQids()` excludes it from **every** future discovery run, permanently, with no
recheck window and no un-skip in the UI. That is right for one operator: it means "this taxon will
never have a usable photo, stop offering it".

It is wrong the moment two people share the deployment. A skip is one person's judgement written
into a **shared, global** row, so the second user never sees the taxon at all and has no way to know
it was ever there, let alone disagree. The failure is silent in the direction that matters: work
that someone would have done simply never appears.

Not fixed now, because today's deployment is loopback-only and single-user, and guessing at the
shape of multi-user state before there is a user model is how you get a schema you have to migrate
twice. What the fix has to reckon with when it comes:

- **A skip becomes per-user, not per-finding** — which needs the identity OAuth brings, so this is
  naturally the same piece of work. `resolution` already carries JSON and could hold who, but the
  *exclusion* lives in `skipQids`, which is global by construction.
- **Discovery must still not resurface a taxon everyone has skipped**, or the backlog fills with
  work every user has already refused. So the exclusion is probably "skipped by *this* viewer" for
  display and "skipped by *everyone*" for discovery — two different questions on the same rows.
- **Some skips really are global facts** ("this taxon has no photo and never will") rather than
  personal ones ("not my area"). Worth capturing the difference at skip time — the `reason` field
  exists and is currently always `null`, because nothing ever sends one.
- **Un-skip has to exist** before any of this is safe. Today reversing a skip means an UPDATE
  against `data/findings.db` by hand.

**Rejected: keeping skips in `localStorage`.** Proposed 2026-08-16 as the cheap way to make them
per-user, and it does solve the stated problem — one person's skip stops hiding work from everyone
else. It is still the wrong shape, for the reason this whole document exists:

- It is **the defect being removed, put back**. The "Why" section above is about state that lived in
  `localStorage` (`winc-uploaded`, `winc-p18`), keyed per browser profile, invisible to the checkers
  and dying with the profile. Slice 4 was largely the work of moving it out. Skips are not a
  smaller case: a skip is a judgement about a taxon, worth as much as a confirm.
- **Discovery cannot read a browser.** `skipQids()` is what stops a skipped taxon being fetched
  again, and it runs in a forked child against SQLite. Move the state client-side and every run
  re-discovers taxa the user already refused, forever — the backlog fills with exactly the work
  someone said no to, and the server has no way to stop.
- The CLI reports and `output/drafts.html` would keep offering skipped taxa too, because they render
  from the database.

**The shape that works, and works now:** keep the state server-side and give it a *key*. A random
opaque id in `localStorage` — a browser identifier, not a judgement — lets skip rows be scoped per
client immediately, with no user model and no OAuth. Discovery excludes a taxon once *every* known
client has skipped it (or once one marks it a global fact), and when identity does arrive the id is
replaced by a real user id without moving any data. That keeps `localStorage` holding one thing it
is actually good for: which client this is.

## Known: a CLI run killed outright stays `running` forever

Raised 2026-08-19, by doing it. `startRun` inserts a row with `state = 'running'`, and `discover()`
sets the terminal state from a `finally`, so an error or a cancel is recorded honestly — `failed`,
`cancelled`, `done`. What bypasses that block is a signal: **Ctrl-C on a checker is enough**, since
Node's default `SIGINT` terminates without unwinding pending async work, and `SIGKILL` obviously is.
The row is then a permanent claim that a run is in progress.

`store.reconcileRuns()` exists for exactly this and does the right thing — every `running` row
becomes `interrupted`. It is called from **`server/index.js` at startup only**. So the gap is
narrow and specific: someone who drives the CLI and never starts the server accumulates rows that
lie about the present.

**Cosmetic today, and worth knowing why**, because the reasons are what a fix must not break:

- **Nothing is blocked.** `server/jobs.js` holds the single-flight lock in an in-memory `record`,
  not in the `runs` table, so a stale row cannot wedge discovery.
- **Freshness is unaffected.** The "backlog as of" query is `MAX(finished_at) … WHERE finished_at
  IS NOT NULL`, which already ignores unfinished runs by design.
- The damage is a misleading history, and it will matter more once anything reports on runs.

**The obvious fix is wrong.** Calling `reconcileRuns()` at CLI startup would mark a *genuinely
live* run as interrupted: the server may be running a discovery child at that moment, and from a
row alone a second process cannot tell "died" from "still going". Two processes share this file —
that is the whole reason `busy_timeout` and `BEGIN IMMEDIATE` are there — so any reconciliation has
to prove the owner is gone, not assume it.

What a real fix needs, roughly in order of cost:

- **A cheap partial:** a `SIGINT`/`SIGTERM` handler in the CLI that marks *its own* run
  interrupted before exiting. Covers Ctrl-C, which is the common case, and nothing else. The
  discovery child already does the equivalent — it aborts on `SIGTERM` so the `finally` runs — so
  this is the same pattern applied to the CLI entry points.
- **The real fix:** record who owns a run (pid plus start time, or a heartbeat column the running
  process touches) and reconcile only rows whose owner is provably gone. That is a schema change,
  which is why it is not worth doing before something actually reads run history.

Related, and deliberately unfixed for the same reason: `reconcileRuns()` is a blunt sweep at
startup, so two servers against one database would each interrupt the other's live runs. Today
there is one server by construction.

## Wanted: an interface for ambiguous matches

Raised 2026-08-16. Two different ambiguities, both currently under-served, and worth solving once:

- **Ambiguous taxon names**, which slice 5c hit immediately: `Bulbophyllum` is a genus *and* a
  section, `Iris` is four taxa. The search page now offers the candidates as chips with their ranks,
  which is enough to pick when you know the group and not enough when you do not — it says nothing
  about where each sits or which has backlog behind it. Lineage per candidate, and a count, would
  make it a decision rather than a guess.
- **Ambiguous iNat↔Wikidata link matches**, which the links checker already produces and dumps into
  `output/links-ambiguous.html` and `output/inat-links-conflicts.json` — files nothing in the app
  reads. Slice 7 brings links into the findings database, and these are the rows a human has to
  adjudicate, so they need a real view: the candidates side by side with the evidence that
  distinguishes them (`compareAncestorTrees` already computes exactly that for `--auto`).

The second is the substantial one and belongs in slice 7; the first is a smaller improvement to
5c's existing prompt.

## Beyond the plan: OAuth upload and direct editing

**Removed from the slice list 2026-08-16 and not scheduled.** It was slice 10, and being last was
not enough — it should not be part of the initial deployment at all. The reasoning is about
sequencing risk, not about wanting it less:

- The whole tool has so far only been driven by hand. It should **run manually for a while first**,
  on real data, so the bugs that only appear in use are found while the worst an edit can do is
  nothing.
- Every other slice is reversible. OAuth is the point where this stops being a worklist that
  *suggests* edits and becomes software that *makes* them, under the operator's own account, on
  Wikidata and Commons. That step is worth taking only once the rest is tight.
- `docs/threat-model.md` says the current no-auth posture "expires" here, and it means it: today's
  protection is a loopback bind plus a CSRF guard, which is adequate for a personal worklist and
  not for a token that can edit Commons.

When it does happen, three things already decided are worth not re-arguing:

- **Register the consumer early, not when the code is ready.** A full consumer at
  `Special:OAuthConsumerRegistration` needs admin approval, and that lead time is the long pole;
  `commons-describe-upload-toolbox`'s note records the same warning from its own experience.
- **This app registers its own consumer** rather than sharing one with the sibling projects; the
  toolbox's OAuth2 work is a model to orient on, not a dependency to wait for.
- **Confirmation collapses into the edit**, because the API returns a revision id synchronously —
  which lands in the `resolution` column that has been written since slice 1, so no migration.

## Not scheduled

Wanted, unsequenced, and deliberately not slices. These are what survived `web-app-architecture.md`
(written before the Fastify decision, absorbed here 2026-08-19); everything else in it was either
built differently or rejected outright — most notably its scheduled-refresh design, replaced by
slice 5b's daily top-up, and its `core/` extraction, which was never needed once the CLI and the
server ended up sharing `lib/` directly.

- **A shared, server-side enrichment cache** — a different thing from the findings database.
  `web/js/enrich.js` caches place hierarchies, category existence, author categories and taxon
  ancestry in `localStorage`, per browser profile, so the same lookups repeat across users and die
  with a cleared profile. Serving them from `/api/enrich/*` over a `node:sqlite` store would dedupe
  them, and would let the server set a descriptive `User-Agent` the browser cannot. Keep today's
  cache keys (`places`, `ancestry`, `catexists`, `authorcat`) and it is a backend swap rather than
  a logic change. Not urgent while there is one operator; the argument gets much stronger the
  moment the read view is public.
- **Background jobs with live progress.** Discovery reports a state flag polled from
  `GET /api/discover/status`, not streamed progress. Revisit if minute-long runs feel too opaque;
  the run record is the seed for a real job system, so nothing is wasted.
- **Auth / multi-user**, which arrives with OAuth and is what
  [global `skipped`](#known-skipped-does-not-survive-more-than-one-user) is waiting on. The shared
  enrichment cache above needs none of it — it is anonymous — but a per-user uploaded-list would.

