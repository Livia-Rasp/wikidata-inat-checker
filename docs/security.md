# Security notes and threat model

**Status: written 2026-08-14 with the Fastify server (slice 3); extended 2026-08-15 when the first
write endpoints landed (slice 4).** Background for `server/`'s configuration and the input-handling
rules in `web/` — read on demand, and **read it before adding any endpoint that changes state or
talks to an authenticated API.**

## What this app is, from a security standpoint

Until this slice the repository shipped CLI tools plus a zero-dependency static file server, and the
only thing on a network was the browser talking to public APIs. That has changed: `server/` is a
long-running HTTP service holding an open handle on `data/findings.db`.

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

The deployment is **private**: one operator, not published. The intention is that the read-only
browse view becomes public at some point — it shows exactly what the generated `output/drafts.html`
already shows — and that write paths arrive later behind OAuth.

- **The server binds `127.0.0.1`, and refuses to start bound anywhere else** unless
  `ALLOW_REMOTE_WRITES` is set. Refused rather than warned about: a warning in a log nobody reads is
  not a decision, and this API is unauthenticated. Setting that variable *is* the decision, made
  explicitly and visibly.
- `PORT` (8080), `FINDINGS_DB` (`data/findings.db`), `LOG_LEVEL`, `RATE_LIMIT_MAX`,
  `RATE_LIMIT_WINDOW`, `TRUST_PROXY`, `ALLOWED_HOSTS` and `ALLOW_REMOTE_WRITES` are the knobs. All
  environment variables, never CLI arguments — arguments are world-readable through `ps`, which
  matters once tokens exist.

## Write endpoints (slice 4)

The API is still unauthenticated, so nothing identifies *who* is calling. What `server/writeGuard.js`
establishes, on every non-GET/HEAD/OPTIONS request under `/api`, is that the call came from this app
in this browser or from a local tool — and not from a page on the internet that a browser was
pointed at. Three checks, in order:

1. **A `Host` allowlist** — the loopback names plus anything in `ALLOWED_HOSTS`, 403 otherwise.
   This is the check people skip because "it's bound to 127.0.0.1". **A loopback bind is not a
   defence.** DNS rebinding lets a public page resolve its own hostname to `127.0.0.1` and reach a
   loopback server *through the victim's browser*; the `Host` header is the thing that still says
   `evil.example` when it happens. `ALLOWED_HOSTS` exists because slice 9's Docker deployment is
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
Wikimedia's API budget and not just ours.

### Privileged routes (slice 5)

Discovery is the most expensive thing this server can be asked to do: minutes of Wikidata,
iNaturalist and Commons traffic under the operator's identity. WDQS bans clients that ignore its
limits and iNaturalist blocks above 10,000 requests a day, so the thing being protected here is not
data — it is the **ability to keep using those APIs at all**.

`POST /api/discover` and `/api/discover/cancel` are therefore marked `config: { privileged: true }`,
which adds two requirements on top of the write guard:

1. **A loopback peer address.** Not `Host` — that is client-controlled, and `curl -H 'Host: localhost'`
   forges it from anywhere. `req.socket.remoteAddress` cannot be forged by the caller, so it is what
   gates a route whose cost lands on the operator. (The `Host` allowlist keeps its own job: stopping
   DNS rebinding, where a *browser* sets the header honestly.) **This is the check that still holds
   when the read view goes public.**
2. **`DISCOVER_ENABLED`**, or a 403 explaining why. An endpoint that spends API reputation should
   not be live merely because nobody turned it off.

Two more limits belong to the same reasoning. The taxon scope is schema-validated as either digits
or a name — `%` and `_` are LIKE metacharacters and `descendantInatIds` interpolates the id into
LIKE patterns, so an unguarded wildcard matches a 3M-row table and becomes hundreds of SPARQL
queries. And `POST /api/discover` **never builds the taxa index**: `openTaxaDb()` throws where the
CLI's `ensureTaxaDb()` would download 189 MB and rebuild for minutes.

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
  error responses alike). The CSP is built with `useDefaults: false` and enumerates:
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
  - `connect-src` naming the six APIs `web/js/*` calls directly.
  - Hosts are listed **without a scheme**, so one policy works for `http://localhost` and a future
    `https://` deployment.
  - **`upgrade-insecure-requests` is deliberately absent.** helmet sets it by default. It is
    invisible on localhost — the loopback exemption — and fatal the first time this is served from a
    plain-http LAN address, where every same-origin asset would be upgraded to a port with no TLS.
  - `hsts: false`: whatever terminates TLS owns that header, and an HSTS pin outlives the
    deployment that set it.
  - `crossOriginEmbedderPolicy: false`, explicitly rather than by default — COEP would block the
    iNat images, which carry no CORP header.
- **Rate limiting** (`@fastify/rate-limit`), registered **inside** the `/api` plugin so it covers
  the API and only the API. This is not a stylistic choice: `vue-commons-gallery`'s
  `docs/security.md` records an app-wide limiter tripping on the dozens of same-origin asset
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
- **Bounded requests.** `bodyLimit` 16 KiB (no route accepts a body yet — the ceiling is set so the
  next slice inherits it), `requestTimeout` 30 s, `maxParamLength` 64,
  `onProtoPoisoning`/`onConstructorPoisoning` set to `error`.
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

- **No authentication.** The slice-3 note here said this must not survive slice 4 without *either*
  authentication or an enforced loopback-only bind. Slice 4 took the second option, deliberately:
  the bind is now enforced rather than defaulted, and the write guard above covers the rest. A
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
  property for a read-only service, and it was considered and dropped in slice 3: a read-only
  connection to a WAL database fails when the `-shm` file does not exist and cannot be created, it
  fails outright on a database that has not been created yet, and slice 4 needs to write anyway —
  which it now does.
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

The server makes no outbound requests; the browser does, directly. The concurrency limits and the
contact-carrying User-Agent in `lib/utils.js` are a security property as much as politeness — being
a badly-behaved client is how a Wikimedia API budget or, later, an OAuth grant gets lost.
