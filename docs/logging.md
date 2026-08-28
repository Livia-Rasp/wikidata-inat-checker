# Structured logging

`server/`'s logging, for anyone debugging a deployed instance or extending what gets logged.
Written 2026-08-28 as part of adding [the MCP log reader](mcp-server.md), which is what actually
motivated going beyond Fastify's stdout-only default.

## What exists, and why

Fastify already logs NDJSON to stdout via its built-in pino logger — that alone was enough while
`docker logs`/`docker compose logs` was the only way anyone would ever read it. It stopped being
enough the moment reading those logs from outside the container mattered: Docker's own `json-file`
driver caps rotation at `compose.yaml`'s 10m/3 files, and nothing outside `docker logs` can get at
it at all.

`server/logger.js`'s `createLogger()` fixes that with two changes, both ported from the pattern
already proven in the sibling project `vue-commons-gallery`:

- **A second destination.** Every line still goes to stdout (so `docker compose logs` keeps
  working unchanged) *and* to a daily-rotated file under `logs/` (`pino-roll`, `dateFormat:
  'yyyy-MM-dd'`, 20 MB cap, `LOG_RETENTION_DAYS` — default 7 — kept before the oldest is deleted).
  `logs/` is a bind mount in `compose.yaml`, not a named volume, deliberately: the MCP server (a
  separate container) needs a plain, directly-readable host path, the same reason `./data` is a
  bind mount rather than a volume.
- **Correlation ids.** `server/app.js` honours an incoming `x-request-id` header if present,
  generates a `crypto.randomUUID()` if not (Fastify's own fallback is a per-process incrementing
  counter — unique within one process, not across a redeploy or a second instance), and echoes it
  back on every response. Every log line for a request carries it as `reqId`, which is what makes
  `logs_request` — the MCP server's "what actually happened in this one request" tool — possible
  at all.

**`dateFormat` and `limit.removeOtherLogFiles: true` must both be set for retention to actually
prune old files.** `vue-commons-gallery`'s own logging hit a production bug from getting this
wrong: `pino-roll` only recognises files as its own rotation series when the date is in the
filename, and won't clean up ones it doesn't recognise as such — see that repo's `docs/logging.md`
for the incident. Both are set in `server/logger.js`'s `createLogger()`; if that ever changes,
recheck against that history before assuming a simpler config is equivalent.

## `timed()` and step-level tracing

`server/logger.js` also exports `timed(log, label, fn)`: wraps an async step, logs
`{label, durationMs}` at `info` on success or the error (with `err` attached) at `error` on
failure, then rethrows. It exists so the MCP server's `logs_slow_requests` and `logs_latency`
tools can answer *which part* of a slow request was slow, not just that it was.

Wired in today at `server/routes/findings.js`'s `confirm()` (`confirmByKind`) and
`server/routes/discover.js`'s `GET /discover/area` handler (`fetchAreaSpecies`,
`fetchAreaCandidates`) — the two places a request does real outbound work. Extending it to a new
route or a new step inside an existing one is exactly this shape:

```js
import { timed } from '../logger.js';
// ...
const result = await timed(reply.log, 'myStepName', () => doTheActualWork());
```

`reply.log`/`req.log` is Fastify's per-request child logger — passing it (rather than `app.log`)
is what gets `reqId` onto the resulting line for free.

## `log = console` through `lib/`

The shared `lib/` helpers that make the actual Wikidata/iNaturalist/Commons network calls
(`lib/utils.js`'s `fetchWithRetry`/`sparql`/`sparqlTSV`/`sparqlPost`/`fetchEntitiesBatched`/
`cirrusCount`/`checkCommonsCategories`, and the `confirm`/`verify`/`discover*`/`areaCandidates`
functions that call them) all take an optional trailing `log`, defaulting to the whole `console`
object — not a single function, unlike `lib/generateWikitext.js`'s pre-existing `log = console.log`
convention. These call sites want `.warn`/`.error` level separation on their retry/failure paths,
and passing the whole object needs no adapter in either direction: `console` and a pino logger
both already expose `.warn`/`.error`.

Every CLI checker (`checkImages.js`, `checkLinks.js`, …) never passes `log`, so it keeps writing to
`console` exactly as before — this was purely additive. The server passes its real per-request
logger through starting at `server/routes/*.js`, so a retry or a Wikidata failure triggered by a
confirm or a discovery request shows up structured, in the request's own log lines, tagged with
its `reqId`.

## Reading logs locally

```sh
LOG_LEVEL=debug npm run web                 # more verbose, same NDJSON shape
tail -f logs/current.log | node -e '...'    # current.log is pino-roll's symlink to today's file
```

For anything beyond "tail it live", use [the MCP server](mcp-server.md) instead of a fresh `jq`
pipeline each time — that reconstruction cost is the whole reason it exists.
