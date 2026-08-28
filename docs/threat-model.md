# Threat model for `server/`

> This is an **engineering design record**, not a vulnerability-disclosure policy: it explains what
> the server defends against, why every header and limit is set the way it is, and what is
> deliberately left undone. To report a security problem in this project, open an issue.

Read it before adding any endpoint that changes state or talks to an authenticated API. Written
2026-08-14 with the Fastify server, extended 2026-08-15 when the first write endpoints landed.

## What this app is, from a security standpoint

The repository used to ship CLI tools plus a zero-dependency static file server, and the only thing
on a network was the browser talking to public APIs. That changed when the backend arrived:
`server/` is a long-running HTTP service holding an open handle on `data/findings.db`.

Three things follow.

1. **The database is the asset, not the data it contains.** Every finding describes public
   Wikidata/iNaturalist facts — there is nothing confidential to exfiltrate. But `data/findings.db`
   is the one piece of state in this repo that **cannot be regenerated**: it accumulates a worklist
   across runs, including which taxa were deliberately skipped. Losing or corrupting it is the
   damage worth preventing.
2. **Consumption is the realistic attack.** A synchronous SQLite driver means every request blocks
   the event loop, and the browser app spends the operator's IP against the iNaturalist, Commons and
   Wikidata APIs. Bounding requests matters more than protecting response contents.
3. **Write access is now here, and it is why the write guard exists.** `POST /api/findings/:id/confirm`,
   `/skip`, and the uploads and import endpoints change stored state. They change *this app's*
   state only — no external edit is made, and nothing is destroyed: the worst an attacker achieves
   is marking findings skipped or planting rows in `uploads`, which is vandalism of a personal
   worklist rather than of Wikidata. That severity rises sharply **whenever OAuth lands**, when the
   same origin gains a token that can edit Commons and Wikidata directly — which is one reason that
   work is now outside the roadmap's ordered plan rather than merely at the end of it.

## Deployment posture today

**The source being public does not make the deployment public.** There is no hosted instance: you
run this yourself, against your own database. Everything below describes that single-operator
posture. The intention is that the read-only browse view becomes reachable by others at some point
— it shows exactly what the generated `output/drafts.html` already shows — and that write paths
arrive later behind OAuth.

- **The server binds `127.0.0.1`, and refuses to start bound anywhere else** unless
  `ALLOW_REMOTE_WRITES` is set. Refused rather than warned about: a warning in a log nobody reads is
  not a decision, and this API is unauthenticated. Setting that variable *is* the decision, made
  explicitly and visibly.
- **In a container that decision is already made for you, and narrowed on purpose.** (How to run
  it, and what the published port costs you, is in [container.md](container.md).) A container is
  reached from outside its own network namespace, so `compose.yaml` must set `HOST=0.0.0.0` and
  therefore `ALLOW_REMOTE_WRITES=1`. What keeps that from being an exposure is the published port:
  it is bound to **the host's loopback** (`127.0.0.1:8080:8080`), so the app is reachable from the
  machine running it and not from the network. Moving that to `0.0.0.0:8080` publishes an
  unauthenticated API to the LAN, and is exactly the decision this variable exists to make
  deliberate.
- **`ALLOWED_HOSTS` is deliberately unset in the container.** Reached as `localhost:8080`, the
  `Host` header is a loopback name the write guard already accepts. It is needed only when a
  reverse proxy puts a different name in front — and then `TRUST_PROXY` is needed too, or the rate
  limiter buckets every client together.
- The knobs, all environment variables and never CLI arguments — arguments are world-readable
  through `ps`, which matters once tokens exist:

  | Variable | Default | What it does |
  |---|---|---|
  | `HOST` | `127.0.0.1` | Bind address. Anything else needs `ALLOW_REMOTE_WRITES`. |
  | `PORT` | `8080` | Listen port. |
  | `FINDINGS_DB` | `data/findings.db` | Which database to open. Honoured by the checkers too, so a container can mount its volume anywhere. |
  | `LOG_LEVEL` | `info` | Pino level. |
  | `ALLOW_REMOTE_WRITES` | unset | Permits a non-loopback bind. Setting it *is* the decision. |
  | `ALLOWED_HOSTS` | loopback names | Extra `Host` values the write guard accepts. |
  | `DISCOVER_ENABLED` | unset | Enables the discovery routes at all. |
  | `TRUST_PROXY` | off | Whether to believe `X-Forwarded-For`. |
  | `RATE_LIMIT_MAX` | 120 | Requests per window for the reads on `/api`. |
  | `RATE_LIMIT_WINDOW` | 1 minute | The window for the read *and* write limits — not the discovery one, which hardcodes a minute. |
  | `RATE_LIMIT_WRITE_MAX` | 30 | Tighter limit for confirm/skip/uploads/import. |
  | `RATE_LIMIT_DISCOVER_MAX` | 6 | Tighter still, for starting a discovery run, per fixed minute. |
  | `DISCOVER_BUDGET_CAPACITY` | 24 | Token-bucket capacity for `POST /discover`, shared with the scheduler's bonus draw (slice 10). |
  | `DISCOVER_BUDGET_REFILL_PER_HOUR` | 1 | How fast that bucket refills. |
  | `DISCOVER_AREA_BUDGET_CAPACITY` | 120 | Token-bucket capacity for `GET /discover/area`. |
  | `DISCOVER_AREA_BUDGET_REFILL_PER_HOUR` | 5 | How fast that bucket refills. |
  | `SCREENSHOT_PORT` | 8099 | Only read by `tools/screenshots.mjs`, which starts its own server. |
  | `TOPUP_ENABLED` | unset | Enables the scheduled top-up (slice 5b) — also needs `DISCOVER_ENABLED`. |
  | `TOPUP_TAXON` / `TOPUP_IUCN` | unset | The scheduled top-up's one fixed scope. |
  | `TOPUP_LIMIT` | 500 | `limit` for each scheduled run. |
  | `TOPUP_RECHECK_AFTER` | discover()'s own default | Days before a negative result is re-checked. |
  | `TOPUP_CHECK_INTERVAL_MINUTES` | 30 | How often the scheduler evaluates whether to run. |
  | `TOPUP_QUIET_HOURS_COUNT` | 6 | How many of the 24 UTC hours count as "quiet". |
  | `TOPUP_QUIET_LOOKBACK_DAYS` | 30 | Rolling window the hourly traffic average is computed over. |
  | `TOPUP_QUIET_MIN_SAMPLE_DAYS` | 7 | Below this much request history, every hour is eligible. |
  | `TOPUP_DAILY_DEADLINE_HOUR` | 23 | UTC hour past which today's top-up runs regardless of quiet hours. |
  | `TOPUP_REQUEST_LOG_RETENTION_DAYS` | 60 | Pruning horizon for the request-volume log. |
  | `TOPUP_BONUS_MIN_BUCKET_FRACTION` | 0.5 | Share of `discover`'s capacity that must still be unused, late in the day, before the scheduler's bonus draw fires (slice 10). |

## Write endpoints

The API is still unauthenticated, so nothing identifies *who* is calling. What `server/writeGuard.js`
establishes, on every non-GET/HEAD/OPTIONS request under `/api`, is that the call came from this app
in this browser or from a local tool — and not from a page on the internet that a browser was
pointed at. Three checks, in order:

1. **A `Host` allowlist** — the loopback names plus anything in `ALLOWED_HOSTS`, 403 otherwise.
   This is the check people skip because "it's bound to 127.0.0.1". **A loopback bind is not a
   defence.** DNS rebinding lets a public page resolve its own hostname to `127.0.0.1` and reach a
   loopback server *through the victim's browser*; the `Host` header is the thing that still says
   `evil.example` when it happens. `ALLOWED_HOSTS` exists because a containerised deployment is
   reached by a different name and would otherwise be locked out of its own write endpoints.
2. **Fetch metadata** — `Sec-Fetch-Site: same-origin|none` passes, `cross-site|same-site` is 403
   (a sibling subdomain is still not us). These headers are *forbidden headers*: the browser sets
   them and page script cannot forge them, which is what makes this the modern CSRF defence and why
   there is no token, no session and no state to synchronise. When `Sec-Fetch-Site` is absent —
   older browsers, and plain-http origins, which are not sent it — `Origin` is compared against
   `Host` instead.
3. **A JSON content type.** Fastify parses `text/plain` by default, and a cross-origin HTML form
   can send exactly that with no preflight, so the content type is part of the defence rather than
   a formality.

**A request with neither `Sec-Fetch-Site` nor `Origin` is allowed on purpose.** A browser always
sends one on a write, so such a request is not a browser — curl, a script, a test — and CSRF is a
browser-only attack. Refusing it would break every local tool and protect nothing.

Confirm and skip carry a **tighter rate limit** than the read API, because a confirm spends
Wikimedia's API budget and not just ours. `POST /api/findings/:id/pick` (slice 7 — resolving an
ambiguous link finding) sits at the ordinary write-guard level, not privileged: it makes no
outbound request at all, purely re-recording which of a finding's own already-known candidates was
chosen, so it costs nothing an attacker could spend against the operator's API budget.

**`clientId` (slice 8b) carries no trust of its own.** Skip, unskip and the findings list all accept
a client-generated id used to scope per-client skips (see
[findings-db-roadmap.md#8b-per-client-skip-scoping](findings-db-roadmap.md#8b-per-client-skip-scoping)).
It is exactly as spoofable as `reason` or any other field the write guard already lets through —
forging one lets a caller claim to be a different "known client," at most changing whose worklist a
skip is scoped to. It is not an identity or auth mechanism, and nothing here treats it as one: the
worst a forged id buys is the same vandalism-of-a-personal-worklist severity every other write
endpoint already carries, not a new capability.

### Discovery budget — POST /discover and GET /discover/area (slice 10)

Discovery is the most expensive thing this server can be asked to do: minutes of Wikidata,
iNaturalist and Commons traffic under the operator's identity. WDQS (the Wikidata Query Service)
bans clients that ignore its limits and iNaturalist blocks above 10,000 requests a day, so the
thing being protected here is not data — it is the **ability to keep using those APIs at all**.

Until slice 10 this was gated on a **loopback peer address** — `req.socket.remoteAddress`,
unforgeable unlike `Host` (`curl -H 'Host: localhost'` forges that from anywhere) — on the theory
that only the operator's own machine should be able to spend the operator's API budget. That held
for a local `npm run web`, but a containerised deployment broke it structurally: a request arriving
through a published Docker port always shows the bridge gateway (`172.x`) as its peer, never real
`127.x`, and `TRUST_PROXY` could not fix it because the check deliberately read
`req.socket.remoteAddress` rather than `req.ip`. The practical effect was narrower than "no discovery
in containers" but just as blocking day to day: **the operator's own browser on the host machine
could not trigger "Find more" or "Add to worklist" at all**, even with `DISCOVER_ENABLED=1` — the
check was correct as written, just never satisfiable from outside the container's own network
namespace. (`docker compose exec` still worked, since a process sharing that namespace genuinely is
loopback — which is how the backlog stayed fillable at all before this slice.) See
[findings-db-roadmap.md](findings-db-roadmap.md#10-discovery-reachable-from-a-deployed-container)
for how this was investigated — Docker-networking-level fixes (`userland-proxy=false`,
`network_mode: host`) were tried and rejected — before landing on what follows.

**The replacement bounds *how much* discovery can cost instead of checking *who* is asking.** Two
independent, hourly-refilling token buckets, one per route, sized two orders of magnitude apart
because their per-call cost is: a `POST /discover` run costs 3–25 iNat requests (`ceil(limit/200)`,
`limit` 500 default–5000 max) and up to ~142 WDQS `VALUES` batches for an unscoped run
(`lib/utils.js`'s `fetchWdTaxaByValues`, `batchSize=10000`, against the ~1.4M-row iNat index); a
`GET /discover/area` call costs exactly **1 iNat + 1 WDQS request**, full stop —
`fetchAreaSpecies` is hardcoded `maxPages: 1` and `fetchAreaCandidates`'s default `candidatesFn` is
one batched WDQS call for the ≤500-species sample. (Per-taxon photo/date *enrichment* is a separate,
much larger cost that never touches this route at all — it fires client-side, straight from the
browser to `api.inaturalist.org`, the same way `gallery.js`'s thumbnails already do.)

| Bucket | Route | Capacity | Refill/hour | Env vars |
|---|---|---|---|---|
| `discover` | `POST /discover`, and the scheduler's own bonus draw | 24 | 1 | `DISCOVER_BUDGET_CAPACITY`, `DISCOVER_BUDGET_REFILL_PER_HOUR` |
| `discover_area` | `GET /discover/area` | 120 | 5 | `DISCOVER_AREA_BUDGET_CAPACITY`, `DISCOVER_AREA_BUDGET_REFILL_PER_HOUR` |

`discover`'s capacity is sized against **WDQS goodwill, not iNaturalist's documented 10,000/day
ceiling** — no numeric WDQS limit is stated anywhere, by WDQS itself or in this repo, so it is the
thing actually bounding this number. 24 unscoped runs/day is already 3,408 WDQS batches, a real 24×
jump over today's single daily scheduled run; "generous" here means comfortably beyond an active
working session (~1/hour around the clock), not "close to iNat's ceiling" — which would be reckless
against a limit with no known value. `discover_area` is sized looser because its true cost (2
requests/call) is two orders of magnitude cheaper — a user panning the map should never feel it.

**Store-backed (`discover_budget`, schema v6, `lib/db.js`), not in-memory like the rate limiter.**
`compose.yaml`'s `web` service already carries `com.centurylinklabs.watchtower.enable=true` (slice
9), so this container gets redeployed on Renovate's ordinary automerge cadence — not rarely. An
in-memory bucket would quietly reset to full on every such restart; a per-minute rate-limit counter
can afford that, a daily/hourly budget cannot. **Verified live**: exhausted a
`DISCOVER_BUDGET_CAPACITY=2` bucket against a real server, restarted it, and the next
`POST /discover` still answered `429` — the budget survived the restart the way it has to.

A plain windowed `COUNT(*) FROM runs` was considered and rejected — it diverges from real
token-bucket semantics exactly when a caller drains the bucket after sitting idle: a real bucket has
a fresh token an hour later; a 24h sliding window still counts yesterday's burst against today for
the rest of the day. Real refill state (`tokens`, `updated_at`, refilled lazily on each draw under
`BEGIN IMMEDIATE`, same discipline `migrate()` uses) is what a token bucket actually is.

**`POST /discover` and `POST /discover/cancel` no longer carry `privileged: true` at all** — the
ordinary write guard (Host allowlist, fetch metadata, JSON content type) plus `DISCOVER_ENABLED`
plus the budget draw is the whole gate now. Cancelling never spent budget to begin with, so it needs
nothing further than the ordinary guard. A draw that then loses `jobs.start()`'s single-flight race
is refunded (`refundDiscoverBudget`) — the token was spent, the run never happened. Exhaustion
answers `429` with a `Retry-After` header, not `403` — this is a quota, not a permission refusal.
The `tool` field on `POST /discover` (`'images'` default, `'links'` since slice 7, `'names'` since
slice 8) picks which pipeline runs but does not change any of the above — links and names discovery
spend the same budget images discovery does, and all three still share one single-flight job slot
(see [dev.md](dev.md#discovery-libdiscoverjs-libdiscoverlinksjs-serverjobsjs)).

### `GET /discover/area` needed a different fix, because it is a GET

Dropping `privileged` from a GET is not the same move as dropping it from a POST.
`server/writeGuard.js`'s guard hook exits early for every safe method (`GET`/`HEAD`/`OPTIONS`)
*before* the Host allowlist, fetch-metadata and content-type checks ever run — reasonable for an
ordinary read, which cannot change state or cost anything. `GET /discover/area` is not an ordinary
read: it makes two real outbound requests on every call. Simply removing its loopback check would
have left it with **no protection at all** against a background cross-origin `fetch()` fired by any
page on the internet — worse than the loopback-only posture it replaced, not better.

**Fixed with a second route-config flag, `costsBudget`**, checked *before* the safe-method exit:
`if (SAFE_METHODS.has(req.method) && !routeConfig?.costsBudget) return;`. A loopback-only bypass
(let `docker compose exec` skip the check, gate everyone else) was considered and rejected — a
genuine loopback caller already sends `Host: 127.0.0.1:8080`, already in the allowlist, so a special
case would only exempt a caller from a check it was always going to pass anyway. `costsBudget`
generalises better: "spends real external API budget" is its own axis, independent of HTTP verb.

**What actually protects this route now, the same rigor given to every other one above:**
`Sec-Fetch-Site` is the check that matters for the attack this closes — modern browsers attach it
even to a cross-origin GET with no custom headers (a CORS "simple request"), so the anonymous page's
background fetch arrives `cross-site` and gets `403`, the identical mechanism every write already
relies on. The Host allowlist still does its own narrower job (DNS rebinding). And even a bare
`curl` — no browser headers at all, "not a CSRF vector," let through on purpose, same as any other
write — is now bounded by the `discover_area` bucket rather than answering forever: 120 draws before
every further call gets `429`, not unbounded drainage. `DISCOVER_ENABLED` and the existing 6/minute
route rate limit both still apply on top, unchanged. Bounded tighter still on `radius` (50km, vs.
`POST /discover`'s 20000km sanity ceiling) and on how many species it samples (`limit`, ≤500) — for
the server's own 30s `requestTimeout`, not for politeness. See
[dev.md](dev.md#area-as-a-scope-libareacandidatesjs-get-apidiscoverarea). **Verified live**: a
spoofed `Host: evil.example` gets `403 host_not_allowed`; a same-origin request succeeds and
correctly draws the bucket.

### The scheduled top-up (slice 5b) — why it needs none of the above

`server/scheduledTopup.js` calls `jobs.start()` directly, in the server process, never over HTTP.
It is not subject to the write guard at all — there is no request for it to inspect. This is not a
gap: the trust boundary that guard defends is "did this call originate from the server's own
process", and code running inside `server/index.js` already satisfies that trivially. Gating it
behind a synthetic internal HTTP call would add a mechanism, not a defence. This is also why it
needed no change when `POST /discover` dropped its loopback-peer check for the budget mechanism
above (slice 10) — the scheduler was never gated on peer address to begin with.

**Since slice 10 this module has a second, related job**: `requestRun()` (called from
`POST /discover`'s handler, not from a timer) is what actually draws the `discover` bucket and
starts the run — so "the scheduled top-up" is a slight misnomer now, though the name is kept rather
than churned, since the timer-driven `tick()` this section is about remains its primary reason to
exist. `tick()` itself also gained one addition: once every tool's own guaranteed daily attempt has
settled (see below), a **once-a-day bonus draw** (`maybeBonusRun`, `evaluateBonusRun`) takes a run
from whatever's left of the shared `discover` bucket if on-demand callers have left real surplus
(`TOPUP_BONUS_MIN_BUCKET_FRACTION`, default `0.5` — over half the day's capacity still unused) and
it is past `TOPUP_DAILY_DEADLINE_HOUR` — reusing that hour rather than adding a second knob, since
it is already this scheduler's own signal for "stop waiting and just run." Recorded with
`triggeredBy: 'schedule-bonus'`, distinguishable from an ordinary `'schedule'` run in `runs`.

What *does* gate it is `TOPUP_ENABLED` (off by default) plus a hard requirement for
`DISCOVER_ENABLED` too, checked at startup in `server/index.js` — a scheduled run spends the exact
same Wikidata/iNaturalist budget an on-demand one does, so it needs the same consent.

**One switch, one scope, tried against all three kinds** since slice 8 (links since slice 7) — not
a `TOPUP_LINKS_*`/`TOPUP_NAMES_*` set of its own. `TOPUP_TAXON`/`TOPUP_IUCN` scope an images tick, a
links tick and a names tick alike; each tracks its own daily-once gate independently (`runs.tool`
distinguishes them), but the single job slot means a tick starts at most one of the three, in that
fixed order. Decided rather than defaulted: giving links or names independent schedule config was
considered and rejected in favour of the simpler shared switch.

**Verified against the real image, both ways.** Without the taxa index mounted, a scheduled tick
starts, `openTaxaDb()` throws `taxa_index_unavailable` inside the forked child, and the container
keeps serving — the same graceful-degradation path slice 5d proved for search. With the real index
mounted read-only, a scheduled run completes end to end (`triggeredBy: "schedule"`, a finding
recorded) and a second tick that day correctly skips (`ran_today`).

**One nuance the missing-index run surfaced.** `discover()` (like the on-demand route) resolves and
validates its scope *before* opening a `runs` row, on purpose — a bad scope should leave no trace.
But `openTaxaDb()` throws even earlier than that, in `discoverChild.js`, before `discover()` is
called at all — so a missing taxa index leaves **no run row**, and the scheduler's daily-once gate
(which reads `runs`) cannot see that an attempt was made. The practical effect: with the index
absent, the scheduler retries every `TOPUP_CHECK_INTERVAL_MINUTES` instead of once a day, until the
index appears. Accepted rather than fixed: the failure is cheap (a fork that dies before the ~650MB
taxa load, not a wasted API call), self-heals the moment the index is built, and the documented
deployment order already has the index built by the CLI before `TOPUP_ENABLED` is ever set — so
this is a narrow, low-cost edge case rather than the expected path.

Two things follow, and the second is a trap:

- Filling the backlog for a containerised deployment is still a job for the CLI, because only the
  CLI may build the taxa index — a run started inside the image fails in milliseconds with
  `taxa_index_unavailable`, regardless of how it was triggered. **What changed in slice 10**: once
  the index *is* mounted, on-demand discovery (`POST /discover`) can now be triggered from anywhere
  the ordinary write guard admits, not only from inside the container's own network namespace — see
  the "Discovery budget" section above.
- **Do not size the container's memory on the assumption that discovery cannot run there.** Mount
  the taxa index one day and it can, whereupon a run forks a child that materialises 1.4M rows and
  spikes to ~650 MB. A limit below that gets it OOM-killed, and `SIGKILL` is never reported as a
  cancel, so the failure arrives as a mystery. `compose.yaml` is sized for the spike.

Everything else is unaffected: `GET /api/discover/status` is unprivileged and answers anyone, and
confirm, skip, uploads, import, `POST /discover` and `POST /discover/cancel` all check only the
`Host` allowlist, fetch metadata and content type (`POST /discover` also draws its budget — see
above), so they work normally through a published port. `GET /discover/area` is the one route still
carrying its own extra check (`costsBudget`, above) beyond that ordinary guard.

Two more limits belong to the same reasoning. The taxon scope is schema-validated as either digits
or a name — `%` and `_` are LIKE metacharacters and `descendantInatIds` interpolates the id into
LIKE patterns, so an unguarded wildcard matches a 3M-row table and becomes hundreds of SPARQL
queries. And `POST /api/discover` **never builds the taxa index**: `openTaxaDb()` throws where the
CLI's `ensureTaxaDb()` would download 189 MB and rebuild for minutes.

### The search routes — unprivileged, and the first public reads over the taxa index

`GET /api/search` and `GET /api/taxa/suggest` are deliberately **not** privileged: they are reads
over data this server already serves, they make no outbound request, and they cannot start anything.
That is the property the whole page is built around — looking is free, fetching is the button.

Three things about them are load-bearing:

- **The same `TAXON_PATTERN` guard as discovery**, for a reason that no longer looks obvious: search
  never calls `descendantInatIds`, so the LIKE-injection argument above does not apply to it
  directly. It keeps the pattern anyway because there is one input validator for taxon names
  (`resolveTaxonId`), used by both, and a route that relaxed its own copy would be the one that
  eventually got wired to something that does scan.
- **`suggest` is a bounded range over `idx_name`**, `name >= ? AND name < ?`, never a `LIKE` — an
  unbounded or leading-wildcard pattern on a 3M-row table is a denial-of-service primitive on a
  synchronous driver. The prefix must start with a letter, and `limit` is capped at 10.
- **A missing taxa index degrades rather than 503s.** Discovery cannot run without it; search can
  still match the names in the findings database. This matters here because the read view is the
  part meant to go public: it must not be takeable down by the state of a file in `~/.cache`. The
  response says `degraded: true` rather than quietly answering a different question.

Both routes still sit behind the write guard's `Host` allowlist and a rate limiter, and still send
`cache-control: no-store` — a cached backlog is a worklist someone has already worked through.

Runs happen in a forked child, which is a security property as much as a performance one: a wedged
or malicious-input run cannot take the API down with it, and both a wall-clock cap and a progress
watchdog exist because Node's `fetch` has no default timeout. Every outbound request now carries a
timeout and a `User-Agent` — the iNaturalist calls, which are the bulk of a run, previously carried
neither.

`test/writeGuard.test.js` covers each rejection, and re-runs every case against `GET` to prove the
read path is untouched — the read view is meant to become public, and a guard that quietly broke it
would be discovered by users rather than by tests.

## What is in place

- **Security headers** (`@fastify/helmet`, registered first so they cover static assets, 404s and
  error responses alike). The CSP (Content Security Policy) is built with `useDefaults: false` and
  enumerates:
  - `script-src 'self'` with **`script-src-attr 'none'`** and no `'unsafe-inline'`. This is the
    directive the delegated-listener refactor exists for: the app previously used `onclick=` /
    `onchange=` attributes, and it builds its table from database content with `innerHTML`, so an
    inline-script escape hatch would have been open on exactly the surface where injected markup
    would land.
  - `style-src 'self'`, also without `'unsafe-inline'` — there are no `style=` attributes in any
    template, and `el.style.x = …` is CSSOM, which the directive does not govern.
  - `img-src` naming the iNat photo hosts, which are **not** the hosts the app fetches JSON from:
    open-licensed photos come from `inaturalist-open-data.s3.amazonaws.com`. Miss it and every
    thumbnail is blocked while the page still renders — a silent failure.
  - `img-src` also names OpenStreetMap's three tile subdomains (`a`/`b`/`c.tile.openstreetmap.org`),
    for `area.html`'s map (slice 6). **`script-src`/`style-src` needed no change for this** — Leaflet
    itself is vendored under `web/vendor/leaflet/` rather than loaded from a CDN `<script>` tag, so
    it is same-origin like every other file in `web/`; only the map tiles are genuinely fetched live,
    and they are images, not script or fetch/XHR, so `connect-src` is untouched too.
  - `connect-src` naming the six APIs `web/js/*` calls directly.
  - Hosts are listed **without a scheme**, so one policy works for `http://localhost` and a future
    `https://` deployment.
  - **`upgrade-insecure-requests` is deliberately absent.** helmet sets it by default. It is
    invisible on localhost — the loopback exemption — and fatal the first time this is served from a
    plain-http LAN address, where every same-origin asset would be upgraded to a port with no TLS.
  - `hsts: false`: whatever terminates TLS owns that header, and an HSTS pin outlives the
    deployment that set it.
  - `crossOriginEmbedderPolicy: false`, explicitly rather than by default — COEP (Cross-Origin
    Embedder Policy) would block the iNat images, which carry no CORP header.
- **Rate limiting** (`@fastify/rate-limit`), registered **inside** the `/api` plugin so it covers
  the API and only the API. This is not a stylistic choice: the sibling project
  `vue-commons-gallery` records an app-wide limiter tripping on the dozens of same-origin asset
  requests one page load fires, and locking the operator — the only legitimate user — out of their
  own tool. `test/server.test.js` asserts both halves: the API limits, ten consecutive asset
  requests do not. The store is in-memory, so a restart clears every counter.
- **`trustProxy` defaults to off**, configurable through `TRUST_PROXY`. Trusting `X-Forwarded-For`
  unconditionally would let anyone bypass the rate limit by rotating a header; leaving it off behind
  a real proxy would collapse every client into one bucket. Set it to the proxy's address when, and
  only when, a proxy exists.
- **Sanitised errors.** Fastify's default 500 includes `err.message`, and a `node:sqlite` error
  carries the absolute path of the database. `setErrorHandler` logs the real error and answers with
  a bare `Internal Server Error`; 4xx pass through, because a validation error describes the
  caller's own input. The 404 handler does not echo the requested path back.
- **Strict input validation.** The querystring is JSON-schema validated with
  `additionalProperties: false` *and* `removeAdditional: false` — Fastify's default would silently
  drop an unknown parameter, so `?kinds=image` would return the default worklist as though it had
  been asked for. `limit` is capped at 2000 because every query blocks the event loop.
- **Bounded requests.** `bodyLimit` 16 KiB — set while the server was still read-only, so the
  write endpoints inherited a ceiling rather than choosing one; `requestTimeout` 30 s,
  `maxParamLength` 64, `onProtoPoisoning`/`onConstructorPoisoning` set to `error`.
- **Quiet, redacted logs.** A `LogController` subclass logs the API's request lines and stays silent
  about static assets — one page load is ~8 asset requests, which would bury the traffic worth
  reading. Fastify's default serialiser logs no headers, so nothing is exposed today; `redact`
  covers `cookie`, `authorization` and `set-cookie` anyway, because the sibling project leaked a
  foreign `localhost` cookie into its logs by adding a serialiser later, and this process will hold
  OAuth tokens once that work happens.
- **No caching of worklists.** `cache-control: no-store` on every `/api` response: a cached backlog
  is a worklist someone has already worked through. Static assets are served with `maxAge: 0`
  because nothing in `web/` is content-hashed, so a positive max-age would run last week's
  JavaScript against this week's API.
- **Static serving is narrow.** Root is resolved from the module, not from the working directory;
  `serveDotFiles: false`; directory listing off; no SPA fallback (a fallback would turn every typo
  into a plausible-looking wrong page); `web/data/` is not served at all.

## What is deliberately not done

- **No authentication.** When the server was read-only this document said the posture must not
  survive the first write endpoint without *either* authentication or an enforced loopback-only
  bind. The second option was taken, deliberately: the bind is now enforced rather than defaulted,
  and the write guard above covers the rest. A
  shared token was considered and rejected as the wrong shape — a static browser app cannot hold a
  secret, and a per-deployment token is not the per-user identity OAuth becomes, so building it
  would have meant building the wrong thing first.
  **This is what expires when OAuth lands**, when the same origin gains a token that can edit
  Commons and Wikidata: at that point CSRF protection stops being enough on its own, because the
  attacker's target is no longer this app's worklist but the operator's edit rights. That work is
  deliberately outside the roadmap's ordered plan, so this posture is good for the whole of the
  initial deployment and no further.
- **No TLS.** Whatever fronts this deployment terminates it. That decision is also why `hsts` is off
  here.
- **No CORS plugin.** The app and the API are same-origin, so CORS is never consulted. If a separate
  origin ever needs access it gets an explicit allowlist — never a wildcard, and never a wildcard
  together with credentials.
- **No read-only database handle.** `{ readOnly: true }` would have been the theoretically right
  property for a read-only service, and it was considered and dropped: a read-only connection to a
  WAL database fails when the `-shm` file does not exist and cannot be created, and fails outright
  on a database that has not been created yet. The write endpoints then arrived and needed the
  handle anyway.
- **No CSRF tokens, sessions or per-user accounts.** Token-based CSRF protection needs server-side
  state and a session to bind the token to; fetch metadata needs neither and cannot be forged by
  page script, so it is both stronger and simpler here. Accounts arrive with OAuth, whenever that
  happens, registering **this app's own** consumer rather than sharing one with the sibling projects.
- **Uploads are never verified against Commons.** The `uploads` table records what the app was told
  was uploaded; the app only ever pre-fills the upload form, so until the app performs the upload
  itself, every row there is the operator's own claim and nothing depends on it being true.

## Concurrency and data safety

The server and a running checker hold the same database open at once — the first time in this
project that two processes touch `data/findings.db`. `openFindingsDb` therefore sets `busy_timeout`
**before** `journal_mode = WAL` (the WAL switch itself takes a brief exclusive lock, which fails
immediately with `SQLITE_BUSY` without a timeout in effect), and `migrate()` uses `BEGIN IMMEDIATE`
with the schema version re-read inside the transaction, so two processes creating a fresh database
cannot both try to build the schema.

Two operational consequences worth knowing:

- Committed writes from a checker are visible to the server immediately; no restart is needed.
- The connection is bound to the file it opened. **Restore a `VACUUM INTO` backup over the database
  and the running server keeps serving the old one** — restart it after any restore.

## Outbound etiquette

Three parties spend the operator's API budget, and the third only arrived with discovery:

- **The browser**, directly — iNaturalist, Commons, WDQS and Nominatim, from `web/js/*`. This is
  the bulk of it, and the reason `connect-src` enumerates exactly six hosts.
- **The server process**, on a confirm: `wbgetentities` against the Wikidata Action API. Small,
  bounded by the write rate limit, and the reason that limit is tighter than the read one.
- **The forked discovery child**, which is by far the most expensive — minutes of WDQS, iNat and
  Commons traffic per run. Every request it makes carries a timeout and a `User-Agent`; the iNat
  calls, which are most of a run, previously carried neither.

The concurrency limits and the contact-carrying User-Agent in `lib/utils.js` are a security
property as much as politeness — being a badly-behaved client is how a Wikimedia API budget or,
later, an OAuth grant gets lost. That User-Agent interpolates `package.json`'s version rather than
hardcoding it, so it cannot go on announcing a release that shipped a year ago; nothing tests a
User-Agent string, so the drift would otherwise be silent.

## Dependency policy

Configured in `renovate.json5`, run by `.github/workflows/renovate.yml`. Seven production
dependencies is few enough that this is cheap and many enough that doing it by hand would not
happen.

- **A 14-day release-age floor under everything.** Nothing is proposed until it has been public for
  two weeks. Malicious npm releases are typically yanked within days of discovery, so the wait is
  what makes unattended automerge defensible at all — and this repository builds its dependencies
  into a container image it publishes, so a compromised package reaches something that ships.
- **Security fixes skip that queue**, and the schedule, and the PR limits. That is Renovate's
  default for `vulnerabilityAlerts` and is deliberately not restated in the config. It reads
  GitHub's Dependabot alerts, which takes **two** separate grants and fails quietly without either:
  Dependency graph and Dependabot alerts enabled on the repository, **and `Dependabot alerts:
  Read` on the token itself**. Miss the token half and the dashboard says
  `Cannot access vulnerability alerts` under "Repository Problems" — which is the only place it is
  reported. The first Dependency Dashboard run was missing it; the grant was added to the token on
  2026-08-21 and the dashboard's Repository Problems block is clear now. It fails quietly, so it is
  worth checking again after any token rotation.
- **`osvVulnerabilityAlerts` is on**, which adds more than extra CVE coverage: OSV data lets
  Renovate recognise a package that has been taken over and refuse to propose updates to it at
  all, rather than dutifully bumping into the malicious release.
- **Automerge is gated on the container, not just the unit suite.** Non-major updates merge
  themselves once `test` *and* `docker` pass — and `docker` builds the image, boots it and makes a
  request. A Fastify patch that breaks plugin registration fails there rather than reaching `main`.
  Majors always wait for a human.
- **The merge gate is GitHub's, not the bot's.** `platformAutomerge` hands the PR to GitHub's
  native auto-merge, which requires "Allow auto-merge" plus a ruleset requiring those two checks.
  Without the ruleset the platform may merge before the checks have even started. Note the
  corollary for a single-maintainer repository: **required reviews must stay off**, or nothing can
  ever automerge.
- **The token is not `GITHUB_TOKEN`.** Pull requests opened with it have their workflow runs held
  in an approval-required state, so CI would need a click per PR and automerge could never be
  satisfied unattended. A fine-grained PAT or GitHub App token with **Contents** write, **Pull
  requests** write and **Dependabot alerts** read is enough — *not* Workflows write, because this
  config deliberately does not extend `config:best-practices` and so never rewrites anything under
  `.github/workflows/`.
- **Running the workflow by hand outside the schedule window does not open PRs**, and that is not a
  failure. Renovate populates the Dependency Dashboard and lists the updates under "Awaiting
  Schedule"; the config's `schedule` decides when branches are actually pushed. The dashboard has
  a checkbox per entry to force one through early. Live since 2026-08-20.
- **Node is grouped.** It is pinned in four machine-readable places that must agree — `.nvmrc`,
  `engines`, `node-version` in CI, and the Dockerfile's `FROM` — so one release arrives as one PR.
  It is never automerged, because a Node major also needs prose and a badge changed by hand.
  `engines: ">=26"` is expected not to move on its own: it is a support floor, and 27 satisfies it.
