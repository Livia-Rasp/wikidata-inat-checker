# Findings database roadmap

The plan for turning the checkers from one-shot report generators into a persistent, resumable
worklist served by a small backend. Written 2026-08-14; the decisions behind it are summarised
below, the ordered work is in [Slices](#slices).

Project-level context lives in the Obsidian vault (`Wikidata iNat Checker`); this file is the
implementation detail. It is the **plan of record**: where it disagrees with
[web-app-architecture.md](web-app-architecture.md), this wins. That document keeps what this one
does not cover — the Fastify rationale, the `core/` extraction, the page structure, and the shared
enrichment cache (a separate thing from the findings database).

## Why

The `cache/cache-*.json` files are tombstones, not caches: they record `inatId → date-checked` and
never the result. The results live in `output/*.html` and `web/data/taxa.json`, which are
overwritten wholesale on every run. So **a second run destroys the backlog from the first** — those
taxa are cached, therefore skipped forever, and what described them is gone. That is why a batch
cannot be worked through at leisure, and it gets worse the moment anything runs on a schedule.

Separately, the "done" state lives in `localStorage` (`winc-uploaded`, `winc-p18` in
`web/js/cache.js`), keyed per browser profile, so the checkers cannot see it and it dies with the
profile.

## Decisions

- **The findings table is never meant to be complete.** Transferring everything iNat could give
  Wikidata in one go is far too much. The workflow is: fetch a batch, work through it, and when it
  is nearly done fetch more — untargeted, or scoped to a family, an IUCN status or an area.
  Discovery is a *user-triggered action with a scope*, not a schedule. This is why there is no TTL
  sweep, no daily budget scheduler and no revalidation cron in this plan.
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
- **OAuth comes last, with its own consumer.** Each of the three apps
  (this, `commons-describe-upload-toolbox`, `vue-commons-gallery`) registers its own token; the
  toolbox's logic is a model to orient on, not a dependency to wait for.

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

### 2. Verification pass
Adds `lib/verify.js` — batched `wbgetentities` (50 QIDs per call), widening `fetchEntities`'
`sitefilter` from `specieswiki` to include `commonswiki`, handling redirects (compare the requested
QID against the returned entity's own id; a mismatch means the item was merged) and deleted items
(`missing`). Adds a `verifyFindings.js` entry script.

**Working means:** `npm run verify` prunes the backlog — findings whose P18 appeared meanwhile
become `fixed_upstream`, merged or deleted items become `gone`, and the reports stop offering work
that is already done.

**Not in this slice:** confirmation of my own edits (that needs the write path in slice 4).

### 3. Fastify serves the images app from the DB
Adds `server/` — Fastify serving the static `web/` plus a read-only
`GET /api/findings?kind=image&status=open`. `web/js/main.js` fetches the API instead of
`web/data/taxa.json`. `npm run web` starts the server.

**Working means:** the app shows live data with no export step in between. The `taxa.json` exporter
stays for one more slice as a fallback, then goes.

**Not in this slice:** any write endpoint. This is deliberately the smallest backend that works.

Folding this into slice 4 was considered and rejected (2026-08-14): it would produce a single commit
that changes where the data comes from *and* introduces the first write path, which is exactly the
shape that is miserable to bisect when the app later shows the wrong rows. Keep them separate.

### 4. Confirm-gated done state in the DB
Adds `POST /api/findings/:id/confirm` — runs the slice-2 verification for that single QID and marks
`done` **only if the edit is actually live**, otherwise leaves it `open` with a reason — plus
`POST /api/findings/:id/skip`. A one-time importer pulls existing `winc-uploaded` / `winc-p18`
`localStorage` contents into the DB.

**Working means:** done-state survives a cleared browser profile, and a taxon cannot be marked done
on the strength of a copied QuickStatements line that was never pasted.

Note: confirmation must be idempotent and re-runnable. A QuickStatements batch can be queued, so
confirming too eagerly can fail spuriously; a failed confirm is a no-op that leaves the finding open,
never an error state.

**Not in this slice:** discovery from the UI.

### 5. On-demand scoped discovery from the app
Extracts `lib/discover.js` from `checkImages.js`, leaving the entry script a thin CLI wrapper over
it, and adds `POST /api/discover { scope, limit }` with progress reporting. UI gains a "top up
backlog" control with scope inputs.

**Working means:** the full loop — top up, work through, top up again, scoped to a family or an IUCN
status — runs without touching a terminal.

**The trap to test here:** top-up must exclude findings of *every* status, not just `open`. Get it
wrong and every taxon deliberately skipped comes straight back.

### 6. App shell, plus area as a discovery scope
Introduces the multi-page shell and navigation (the first slice with a second page to justify it),
folds `checkArea.js` in as a third discovery scope writing `kind=image` findings, and gives it an
`/area` subpage carrying the photo and latest-observation enrichment.

Fix the known enrichment gap here rather than separately: the per-taxon photo/date lookup queries 20
taxa against one shared result window, so a few dominant taxa starve the rest and up to 19 per batch
come back with a blank date. Taxa are not dropped, only their enrichment. Confirm it still
reproduces first — it was noted 2026-07-02 and has not been re-verified.

**Working means:** the area checker is part of the app, and the `TODO(area-enrichment)` comment and
the "Known limitation" section in `docs/area.md` are gone. `docs/area.md`'s "How it works" and layout
table are also stale about the latest-date column and the real sort order; tidy them in the same
pass.

### 7. Links checker → `kind=link` and a `/links` subpage
Migrates `checkLinks.js` onto the findings table with P3151 as the verification predicate, keeping
the `--auto` QuickStatements output. Simplest payload of the three, so it is the right one to prove
the schema really is multi-kind before the more complex names data lands.

`checkLinksStats.js` keeps working off the same tables.

### 8. Names checker → `kind=name` and a `/names` subpage
Migrates `checkNames.js`. Verification is per-language: P1843 must not already carry a name in the
language the finding proposes.

### 9. Dockerise, with a persistent volume and backups
Fastify plus a mounted volume for the findings database, port 8080. The pipeline shape to copy is
`docs/deployment-roadmap.md` in the `vue-commons-gallery` repo. Backup is `VACUUM INTO` on a timer;
the database is gitignored, so nothing else is protecting it.

Sequenced before OAuth on purpose, accepting that the deployment will need revisiting for secret
handling once tokens exist — getting the tool onto the home server earlier is worth one redeploy.

### 10. OAuth upload and direct editing
Registers **this app's own** consumer at `Special:OAuthConsumerRegistration`, orienting on
`commons-describe-upload-toolbox`'s OAuth2 work rather than depending on it. Uploads and statement
edits happen in-app; confirmation collapses into the edit itself, because the API returns a revision
id synchronously — which lands in the `resolution` column that has been there since slice 1.

**Register the consumer early, not when the code is ready.** A full consumer needs admin approval,
and that lead time is the long pole; the toolbox's note records the same warning.
