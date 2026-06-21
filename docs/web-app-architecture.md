# Web app architecture — frontend + backend proposal

A **planning record**, not yet implemented. It captures the agreed direction for evolving the
current static `web/` app into a frontend + Node backend with a shared cache, one page per
workflow, and light automation. The current static app is described in
[commons-upload.md](commons-upload.md) / [commons-upload-dev.md](commons-upload-dev.md); the
reusable API recipes live in [commons-integration.md](commons-integration.md).

Nothing here is wired into `CLAUDE.md` yet — that happens as each slice ships.

---

## 1. Why a backend (and why not, today)

The current `web/` app is fully static and works only because every API it calls
(iNaturalist, Commons, Wikidata Query Service) is **CORS-open**. So a backend is not
technically required for what the app does now. What justifies adding one:

| Driver | Decision | Notes |
|---|---|---|
| **Shared cache across users** | **Wanted (future)** | `web/js/enrich.js` caches per-browser in `localStorage`; the same place/category/author/ancestry lookups repeat across users. A server cache dedupes them. Cross-workflow: images and links both resolve taxa. |
| **Automation** (see §5) | **Wanted** | Scheduled refresh, on-demand UI runs, bulk actions. |
| **Multiple pages, one per workflow** | **Wanted (future)** | Today only the image checker has a web UI. |
| Real Commons uploads via OAuth | **Not pursued now** | Would genuinely need a backend (secrets, token exchange). Deferred. |
| Background jobs with live progress | **Not pursued now** | Explicitly out of scope; see the long-run caveat in §5. |

## 2. Recommended stack

Deliberately boring, reusing what the repo already has.

- **Backend framework: [Fastify](https://fastify.dev/).** Right size — fast, first-class
  ESM, schema validation, minimal ceremony. (Express = fine but heavier-feeling; Hono = only
  if edge/runtime portability ever matters. Fastify chosen.)
- **Cache / persistence: `better-sqlite3`** — **already a repo dependency** (it backs the
  iNat taxa index in `getInatTaxaDb.js`). Reuse it for the shared enrichment cache, the
  uploaded-files list, and the run-status records. No Redis/Postgres to operate.
- **Frontend: vanilla, multi-page (MPA)** — one HTML entry per workflow sharing `core/`
  modules and a common nav/layout. No framework, no build step (as today). Add **Vite** as a
  pure build/dev layer (not a framework) only when pages start sharing stateful components.

Rejected for now: React/Vue/Svelte (more boilerplate than the app currently *is*); a job
queue / Redis (out of scope per §5); OAuth/MediaWiki upload libs (deferred).

## 3. Target structure

```
core/                       # environment-agnostic logic — used by BOTH the CLIs and the server
  commonsUpload.js          # already pure (no DOM) — move as-is
  enrich.js                 # place/ancestry/category/author resolution (fetch-based; Node 18+ has fetch)
  generators/               # generate<Workflow>Json — one per tool (images exists; names/links/area new)
  workflows/                # run<Workflow>() async fns returning data — the CLIs become thin wrappers
  clients/{inat,commons,wikidata}.js   # thin API clients (set a descriptive User-Agent server-side)
server/
  index.js                  # Fastify: static serving + API (+ scheduler)
  routes/{images,names,links,area}.js  # GET data, POST /run, GET /status per workflow
  routes/enrich.js          # shared enrichment, served from the SQLite cache
  cache.js                  # better-sqlite3 store; same has/get/set interface as today's Cache
  scheduler.js              # node-cron entries → core/workflows run()
client/                     # today's web/, generalised
  shared/                   # nav, layout, css, the fetch-from-/api helpers
  images.html, names.html, links.html, area.html   + per-page js
checkImages.js, checkNames.js, checkLinks.js, checkArea.js   # import core/ instead of duplicating
```

`web/` is meant to be spin-out-able into its own repo (per `CLAUDE.md`); the
`core/ + server/ + client/` split keeps that boundary clean.

## 4. The keystone: extract `core/`

Everything else hangs off this, so it goes first.

- **Pure logic moves verbatim.** `commonsUpload.js` has no DOM. `enrich.js` is `fetch`-based
  and DOM-free; its only browser coupling is the `Cache` class.
- **`Cache` becomes pluggable.** Same `has/get/set` interface, two implementations: the
  existing `localStorage` one (browser, kept until enrichment moves server-side) and a new
  `better-sqlite3` one (server). Enrichment ultimately runs server-side, so the browser cache
  mostly disappears.
- **Each checker's `run()` becomes a callable async function** in `core/workflows/` that
  *returns data* instead of writing files to `cwd`. The CLI entry (`checkImages.js`, …) shrinks
  to: parse args → call `run()` → write HTML/JSON. This is what lets both `node-cron` and the
  UI trigger invoke a workflow without shelling out.
- **Data contracts for the other three tools.** Only `generateImagesJson.js` exists today;
  names/links/area emit HTML only. Each needs a small, mechanical `generate<Workflow>Json`
  extraction from its existing HTML generator so its page has something to consume.

Low risk: the CLIs keep working throughout (they just delegate to `core/`).

## 5. Automation design

Scope (confirmed): **scheduled refresh**, **on-demand run from UI**, **bulk actions**.
Out of scope: background jobs with live progress.

- **Scheduled refresh** — `node-cron` entries in `server/scheduler.js` call
  `core/workflows` `run()` and persist results (SQLite/JSON). No extra infra.
- **On-demand run** — `POST /api/<workflow>/run` calls the same `run()`.
- **Bulk actions** — batch endpoints (e.g. prepare many upload forms, bulk mark-as-done,
  export QuickStatements), mostly frontend; made cheap by the shared cache.

**Long-run caveat (the one thing to get right).** Runs take minutes (the image checker is
dominated by iNat photo checks), and we deliberately skipped a job queue. So:

- **Per-workflow run-lock + status record** in SQLite: `idle | running | done | error` +
  `lastRun` timestamp + last error.
- `POST /run` starts the run async and returns `202` immediately (never blocks for minutes).
- The cron job **respects the same lock** — a scheduled tick skips if a run is already going,
  so manual and scheduled runs can't collide.
- The UI shows "running… / last refreshed N ago" by polling `GET /status` — a state flag, not
  streamed progress.

This delivers both automation features without the infrastructure we opted out of. If live
progress is wanted later, the run-status record is the seed for a real job system — nothing
wasted.

## 6. Shared cache

- A single `better-sqlite3` DB (separate from the read-only taxa index) holds: the enrichment
  cache (places, category-existence, author categories, taxon ancestry), the uploaded-files
  list, and the run-status records.
- Enrichment is served via `/api/enrich/*`; the frontend stops calling iNat/Commons/WDQS
  directly and calls the backend, which sets a descriptive `User-Agent` (browsers can't) and
  can throttle to respect WDQS/Commons rate-limit etiquette.
- Cache keys mirror today's `Cache` namespaces (`places`, `ancestry`, `catexists`,
  `authorcat`) so the migration is a backend swap, not a logic change.

## 7. Migration plan (staged, each reversible)

| Step | Work | Effort | Risk |
|---|---|---|---|
| 1 | Extract `core/` (pure logic + `run()` per workflow + `generate*Json`) | ~1–2 d | low — CLIs keep working |
| 2 | Fastify serving static + `/api/enrich` on the SQLite shared cache | ~1 d | low |
| 3 | Workflow pages, one at a time (images first — it already has data) | incremental | low |
| 4 | Scheduler + run-lock + on-demand `POST /run` / `GET /status` | ~1 d | medium — see §5 caveat |
| 5 | Bulk actions | incremental | low |

The only step needing care is **1** — the cache, the pages, and all the automation hang off
the `core/` extraction.

## 8. Deferred / open questions

- **OAuth Commons uploads** — the one feature that strictly needs a backend; revisit when
  half-automated prefill stops being enough.
- **Background jobs + live progress** — revisit if minute-long runs in the UI feel too opaque.
- **Auth / multi-user** — the shared cache is anonymous; a per-user uploaded-list would need
  identity. Not required for the cache itself.
- **Per-tool file caches** (`cache-images.json` etc.) could later fold into the shared SQLite
  DB, but that is not required initially.
