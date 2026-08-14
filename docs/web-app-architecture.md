# Web app architecture — frontend + backend proposal

A **planning record**, not yet implemented: how the `web/` app is *structured* once it grows a
backend — the framework choice, the `core/` extraction, the page layout, and the shared enrichment
cache.

> **Read [findings-db-roadmap.md](findings-db-roadmap.md) first.** It is the plan of record and it
> **wins wherever the two disagree**, on persistence, on the order of work, and on automation. This
> document predates it. Sections that conflicted have been cut rather than left to be implemented by
> accident — most notably the scheduled-refresh design, which was rejected outright: discovery is a
> user-triggered action with a scope, never a cron.

What survives here and is *not* in the roadmap: §2 the stack rationale, §3 the target structure,
§4 the `core/` extraction, §6 the enrichment cache (a different thing from the findings database).

The current static app is described in [commons-upload.md](commons-upload.md) /
[commons-upload-dev.md](commons-upload-dev.md); the reusable API recipes live in
[commons-integration.md](commons-integration.md).

Nothing here is wired into `CLAUDE.md` yet — that happens as each slice ships.

---

## 1. Why a backend (and why not, today)

The current `web/` app is fully static and works only because every API it calls
(iNaturalist, Commons, Wikidata Query Service) is **CORS-open**. So a backend is not
technically required for what the app does now. What justifies adding one:

| Driver | Decision | Notes |
|---|---|---|
| **Shared cache across users** | **Wanted (future)** | `web/js/enrich.js` caches per-browser in `localStorage`; the same place/category/author/ancestry lookups repeat across users. A server cache dedupes them. Cross-workflow: images and links both resolve taxa. |
| **Automation** | **Partly — on-demand only** | On-demand runs from the UI and bulk actions, yes. **Scheduled refresh: rejected.** See the roadmap: the backlog is deliberately never complete, so discovery is triggered with a scope when the current batch runs low. |
| **Multiple pages, one per workflow** | **Wanted (future)** | Today only the image checker has a web UI. |
| Real Commons uploads via OAuth | **Not pursued now** | Would genuinely need a backend (secrets, token exchange). Deferred. |
| Background jobs with live progress | **Not pursued now** | Explicitly out of scope; see the long-run caveat in §5. |

## 2. Recommended stack

Deliberately boring, reusing what the repo already has.

- **Backend framework: [Fastify](https://fastify.dev/).** Right size — fast, first-class
  ESM, schema validation, minimal ceremony. (Express = fine but heavier-feeling; Hono = only
  if edge/runtime portability ever matters. Fastify chosen.)
- **Cache / persistence: SQLite via the built-in `node:sqlite`** — no dependency at all (it
  backs the iNat taxa index in `lib/getInatTaxaDb.js`). Reuse it for the shared enrichment
  cache, the uploaded-files list, and the run-status records. No Redis/Postgres to operate.
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
  cache.js                  # node:sqlite store; same has/get/set interface as today's Cache
                            # (no scheduler.js — scheduled refresh was rejected, see §5)
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
  `node:sqlite` one (server). Enrichment ultimately runs server-side, so the browser cache
  mostly disappears.
- **Each checker's `run()` becomes a callable async function** in `core/workflows/` that
  *returns data* instead of writing files to `cwd`. The CLI entry (`checkImages.js`, …) shrinks
  to: parse args → call `run()` → write HTML/JSON. This is what lets both `node-cron` and the
  UI trigger invoke a workflow without shelling out.
- **Data contracts for the other three tools.** Only `report/generateImagesJson.js` exists today;
  names/links/area emit HTML only. Each needs a small, mechanical `generate<Workflow>Json`
  extraction from its existing HTML generator so its page has something to consume.

Low risk: the CLIs keep working throughout (they just delegate to `core/`).

## 5. Long-running requests

**Scheduled refresh was cut** — see the roadmap. `server/scheduler.js` and `node-cron` in §3 are
vestigial; do not build them. What remains is the on-demand path, and its one real problem:

Discovery runs take minutes (the image checker is dominated by iNat photo checks), and there is
deliberately no job queue. So:

- **A run-lock plus status record** in the findings DB: `idle | running | done | error`, the last
  run timestamp, and the last error. The `runs` table in the roadmap's schema v1 is the seed for
  exactly this.
- `POST /api/discover` starts the run async and returns `202` immediately — it must never block for
  minutes.
- The UI shows "running… / last topped up N ago" by polling status: a state flag, not streamed
  progress.

Bulk actions (prepare many upload forms, bulk mark-as-done, export QuickStatements) are mostly
frontend work, made cheap by the shared cache.

If live progress is ever wanted, the run-status record is the seed for a real job system — nothing
wasted.

## 6. Shared cache

- A single `node:sqlite` DB (separate from the read-only taxa index) holds: the enrichment
  cache (places, category-existence, author categories, taxon ancestry), the uploaded-files
  list, and the run-status records.
- Enrichment is served via `/api/enrich/*`; the frontend stops calling iNat/Commons/WDQS
  directly and calls the backend, which sets a descriptive `User-Agent` (browsers can't) and
  can throttle to respect WDQS/Commons rate-limit etiquette.
- Cache keys mirror today's `Cache` namespaces (`places`, `ancestry`, `catexists`,
  `authorcat`) so the migration is a backend swap, not a logic change.

## 7. Migration plan

**Superseded** by the ten slices in [findings-db-roadmap.md](findings-db-roadmap.md#slices), which
is the sequencing of record. The staged table that used to sit here disagreed with it on both order
and content.

The one point worth carrying over: the `core/` extraction in §4 is the keystone. The shared cache,
the per-workflow pages and every automation feature hang off it, so it is the piece to get right
rather than fast.

## 8. Deferred / open questions

- **OAuth Commons uploads** — **no longer open**: it is slice 10 of the roadmap, deliberately last,
  with this app registering its own consumer rather than sharing one.
- **Per-tool file caches** (`cache/cache-images.json` etc.) — **no longer open**: folding them into
  SQLite is the whole point of the roadmap, images first in slice 1.
- **Background jobs + live progress** — still open; revisit if minute-long runs in the UI feel too
  opaque.
- **Auth / multi-user** — still open. The shared cache is anonymous; a per-user uploaded-list would
  need identity. Not required for the cache itself.
- **Deployment, once this backend actually exists** — today's static `web/` app needs no server
  beyond a trivial static-file host, so there's nothing to deploy yet. Once step 2 above ships a
  real Fastify backend, the sibling repo `vue-commons-gallery` has since built (2026-07) a CI/CD
  pattern worth reusing rather than re-deriving: a single Docker image (multi-stage build, backend
  serves the built frontend from the same origin), GitHub Actions publishing to GHCR on push to
  `main` (GitHub-hosted runner only, no self-hosted runner - deliberately, since a persistent
  Docker-socket-privileged CI agent is a real liability on a box meant to run production services),
  and `nicholas-fedor/watchtower` on the target host polling GHCR and redeploying automatically. See
  `vue-commons-gallery/docs/deployment-roadmap.md` for the full writeup and reasoning when this is
  actually being built.
