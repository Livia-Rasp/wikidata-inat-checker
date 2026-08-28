# The log-reading MCP server

**Status: implemented 2026-08-28.** `mcp-server/` is a standalone, read-only MCP server over the
NDJSON logs `server/` writes (see [logging.md](logging.md)). It exposes six tools to Claude Code —
or any MCP client — so questions like "what broke yesterday" or "why was that request slow" are
answered from the logs directly, rather than reconstructed with a fresh `jq` pipeline every time.

Ported from the equivalent, already-shipped server in the sibling repo `vue-commons-gallery`
(`mcp-server/`), whose own `docs/mcp-server.md` already anticipated this exact move — its "Still
open" section noted that pointing the tool at a sibling's logs was "a config change… but none of
the siblings are instrumented yet." A **standalone build was chosen over reusing that image**: the
user was offered image reuse as the lower-effort option and chose to build a dedicated one here
instead. That choice is why this server is **plain ESM JavaScript, not TypeScript** — the reference
compiles with `tsc`, and this repo's own convention is "no build step" (see the root `CLAUDE.md`);
writing it in the same style as the rest of the repo resolves that conflict without introducing one.

## The tools

| Tool | What it answers |
|---|---|
| `logs_files` | How much history exists, in which files, covering which spans. The orienting call. |
| `logs_search` | Lines in a window, narrowed by level, correlation id, URL or free text. |
| `logs_errors` | What failed — error-level lines *and* failing responses, which are not the same set. |
| `logs_request` | One correlation id's whole timeline: retries, `timed()` steps, the completion line. |
| `logs_slow_requests` | Requests over a threshold, each with its per-step duration breakdown attached. |
| `logs_latency` | p50/p95/p99 over a window, grouped by route or by pipeline step. |

**`logs_errors` is an OR, unlike every other filter.** A line counts as an error when it is level
≥ 50 *or* it reported a failing status. Both halves are load-bearing: `confirm()` in
`server/routes/findings.js` answers a Wikidata outage with a logged warning and a 503, but a
rate-limited request is only ever a 429 with no error-level line at all. 4xx is excluded by
default (`includeClientErrors`) since this app has no favicon-404 noise to speak of, but the same
principle applies to any other routine 4xx.

**`logs_latency`'s route grouping is simpler than the reference it was ported from.** The sibling
project collapses arbitrary Commons usernames out of its URLs (`/getImagesForAuthor/:author`);
this app's only parameterised route shape is `POST /api/findings/:id/(confirm|skip|unskip|pick)`,
so `mcp-server/stats.js`'s `normaliseRoute()` is a single regex rather than a general path-param
collapse. **It also drops the reference's static-asset filtering entirely**, rather than port it
inert: `server/app.js`'s `ApiOnlyLogController` already suppresses every log line for a non-`/api`
request, so no static asset ever reaches these files in the first place — there is nothing here to
filter.

## Streamable HTTP, not stdio

Same reasoning as the reference. The app runs on the server-pc; the shell asking these questions
may be on that same box today and a different LAN machine later. A stdio server assumes a shared
filesystem and dies at that move — so: Streamable HTTP with a bearer token, the remote-default
transport both the MCP spec and Claude Code expect. The same client config in `.mcp.json` works
before and after the move; only the host in the URL changes.

Stateless: a fresh server and transport per POST, torn down when the response closes. Every tool
answers one question from files on disk — there is nothing to resume and no server-initiated
message to deliver, so a session would only be state to leak and expire.

## Its own container

`mcp-logs` in `compose.yaml`, built from `mcp-server/Dockerfile`, published to
`ghcr.io/livia-rasp/wikidata-inat-checker-mcp` and redeployed by the same Watchtower as `web` — see
[container.md](container.md). A route inside `server/app.js` would have been less infrastructure,
and was rejected for the same two reasons the reference gives: a log reader must not be able to
affect the app it observes, and the app's own origin must not also grow a tool-calling endpoint.
The separation also makes the read-only contract enforceable from outside the code, via the `:ro`
mount.

## Security

The port (3400 — see the project vault's `Ports.md` registry) is published on the LAN so the shell
can move to a second machine. Three things stand between that and an open log endpoint:

1. **A bearer token.** `MCP_AUTH_TOKEN`, compared in constant time, from `mcp-server/.env`
   (gitignored, copy `mcp-server/.env.example` first). The server **refuses to start** without one
   rather than listening unauthenticated — fail-closed, since the failure mode of the alternative
   is silent. Environment-only, never a `--flag`: command-line arguments are world-readable
   through `ps`.
2. **A Host header allowlist.** `ALLOWED_HOSTS`, enforced as middleware, 403 otherwise. This is
   the DNS-rebinding defence the MCP spec requires of HTTP transports: without it, a page in any
   browser on the LAN can be pointed at this port and made to drive tool calls from inside the
   network. The SDK's own `allowedHosts` transport option is deprecated in favour of exactly this
   middleware.
3. **Read-only, twice.** There are no write tools, and `compose.yaml` mounts the log directory
   `:ro`. Adding a tool that changes anything is an explicit decision, not a convenience.

`/healthz` is deliberately outside all of that: unauthenticated, exempt from the Host allowlist,
and says nothing but `{"status":"ok"}`. The container's own `HEALTHCHECK` calls it, and tightening
`ALLOWED_HOSTS` must not quietly break that.

No TLS — consistent with `web` itself, all LAN-internal. Revisit if this box ever gets an inbound
route from outside the LAN.

## Reading the logs

- Files are `app.YYYY-MM-DD.N.log`, so a `since`/`until` range prunes whole files **by name,
  before opening any of them**. The day window is widened by 24 hours at both ends, because
  `pino-roll` names a file from the writer's *local* midnight and a container writing in UTC
  disagrees with a dev run in CEST about which file an event just after midnight belongs in.
- `current.log` is skipped — it's `pino-roll`'s symlink to the active file, and reading it as well
  as its target would double-count every line written today.
- Everything streams line by line via `readline`; nothing reads a whole file into memory, and the
  aggregate tools (`logs_latency`) hold only the numbers, never the lines they came from.
- Header objects are never returned. `server/app.js`'s `redact` config strips credentials at write
  time (`server/logger.js`), and `mcp-server/read.js`'s `projectLine()` re-adds only a fixed,
  named field set rather than passing `req`/`res` through — so a reader here can't undo that
  redaction the next time a header serialiser changes.

## Testing

`mcp-server/logFiles.js`, `read.js`, `stats.js` and `time.js` — everything that doesn't need an
MCP/HTTP transport in front of it — are unit-tested against fixture NDJSON under
`mcp-server/test/fixtures/`, `node --test`, no network. The MCP protocol layer (`http.js`,
`server.js`, `main.js`) was verified live instead: a real server started against the fixtures,
exercised with raw `curl` `POST /mcp` calls for auth (missing/wrong token → 401, disallowed Host →
403), `tools/list`, and each of the six tools; then again as the actual `mcp-logs` container
alongside `web`, confirming it reads what `web` writes across the bind mount.

## Version choice

`@modelcontextprotocol/sdk` v1, matching the reference and the sibling `winged-eye-obsidian` vault
server, so the MCP servers in this house stay one pattern. `zod` v4 for the same reason — it's a
runtime schema library, not TypeScript-specific, so porting it needed no adaptation.

## Prior art

`vue-commons-gallery/mcp-server/` is the direct ancestor of everything here — read its own
`docs/mcp-server.md` for the fuller rationale (Streamable-HTTP-vs-stdio-over-SSH tradeoffs, the
version-choice discussion against the newer `@modelcontextprotocol/server` package, and the prior
art *it* started from). This document only covers what differs for this app.

## Still open

- **Updating the vault's `Ports.md`** for port 3400 is a manual follow-up, not something this repo
  can do — the vault MCP tool available to Claude here is read-only.
- **A live tail.** Deliberately not built, same reasoning as the reference: a stream is awkward in
  a request/response agent loop.
