# Security notes and threat model

**Status: written 2026-08-14 with the Fastify server (findings-db roadmap slice 3).** Background for
`server/`'s configuration and the input-handling rules in `web/` — read on demand, and **read it
before slice 4**, which adds the first write endpoints.

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
3. **Everything changes with write access.** Slice 4 adds `POST /api/findings/:id/confirm` and
   `/skip`; slice 10 adds OAuth uploads and direct Wikidata edits. Every judgement below was made
   about a **read-only** service and has to be re-made then.

## Deployment posture today

The deployment is **private**: one operator, not published. The intention is that the read-only
browse view becomes public at some point — it shows exactly what the generated `output/drafts.html`
already shows — and that write paths arrive later behind OAuth.

- **The server binds `127.0.0.1` by default.** Exposing it is a deliberate act (`HOST=0.0.0.0`), not
  a default anyone can drift into.
- `PORT` (8080), `FINDINGS_DB` (`data/findings.db`), `LOG_LEVEL`, `RATE_LIMIT_MAX`,
  `RATE_LIMIT_WINDOW` and `TRUST_PROXY` are the knobs. All environment variables, never CLI
  arguments — arguments are world-readable through `ps`, which matters once tokens exist.

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
  OAuth tokens at slice 10.
- **No caching of worklists.** `cache-control: no-store` on every `/api` response: a cached backlog
  is a worklist someone has already worked through. Static assets are served with `maxAge: 0`
  because nothing in `web/` is content-hashed, so a positive max-age would run last week's
  JavaScript against this week's API.
- **Static serving is narrow.** Root is resolved from the module, not from the working directory;
  `serveDotFiles: false`; directory listing off; no SPA fallback (a fallback would turn every typo
  into a plausible-looking wrong page); `web/data/` is not served at all.

## What is deliberately not done

- **No authentication.** The API is read-only over public facts, and the deployment is private by
  binding to loopback. **Slice 4 must not merge without either authentication or an enforced
  loopback-only bind** — that slice adds endpoints that change stored state, and "it only reads
  public data" stops being true at that commit.
- **No TLS.** Whatever fronts this deployment terminates it. That decision is also why `hsts` is off
  here.
- **No CORS plugin.** The app and the API are same-origin, so CORS is never consulted. If a separate
  origin ever needs access it gets an explicit allowlist — never a wildcard, and never a wildcard
  together with credentials.
- **No read-only database handle.** `{ readOnly: true }` would be the theoretically right property
  for a read-only service, and it was considered and dropped: a read-only connection to a WAL
  database fails when the `-shm` file does not exist and cannot be created, it fails outright on a
  database that has not been created yet, and slice 4 needs to write anyway. The server simply
  contains no write statements.
- **No per-user accounts, sessions or CSRF machinery.** Nothing to protect until there is a write
  path; when there is, the OAuth work registers **this app's own** consumer rather than sharing one
  with the sibling projects.

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
