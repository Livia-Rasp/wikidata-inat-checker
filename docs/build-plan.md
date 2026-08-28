# Build plan: server logging + a log-reading MCP server

The ordered ladder for one feature — structured server-side logging plus a standalone, read-only
MCP server that can read it — not a whole-project plan. See
[docs/findings-db-roadmap.md](findings-db-roadmap.md) for that. One slice lands as one commit that
bumps `package.json`'s version, marks its own entry `✅` here, and updates whatever docs it made
stale, together.

Full rationale: [docs/logging.md](logging.md) and [docs/mcp-server.md](mcp-server.md) (both written
as part of slice 13, once there is something to describe). Ported from the equivalent, already-shipped
pattern in the sibling repo `vue-commons-gallery` (`backend/logger.js` + `mcp-server/`), adapted to
this repo's plain-ESM-JavaScript, no-build-step convention.

## Ladder

```
0   scaffold docs/build-plan.md with this ladder                                    ✅
1   lib/paths.js: LOGS_DIR / logPath()                                              ✅
2   server/logger.js: dual stdout+rotated-file pino, redaction, timed()             ✅
3   wire the real logger into server/index.js + server/app.js; correlation IDs      ✅
4   compose.yaml + Dockerfile + .gitignore/.dockerignore: writable logs mount        ✅
5   lib/utils.js: thread `log` through the SPARQL/CirrusSearch/Commons helpers        ✅
6   lib/confirm.js, verify.js, discover*.js, areaCandidates.js: thread `log` from opts  ✅
7   server/routes/*.js + server/app.js: pass req.log/app.log down those call chains      ✅
7b  wire timed() into the confirm and area routes — slice 2 built it, nothing called it  ✅
8   mcp-server/: logFiles.js, read.js, stats.js, time.js + fixture tests (no HTTP yet)     ✅
9   mcp-server/: http.js, server.js, main.js — the MCP protocol layer, six tools           ✅
10  mcp-server/Dockerfile + compose.yaml's mcp-logs service + .env.example                  ✅
11  .mcp.json registration                                                                  ✅
12  .github/workflows/ci.yml: test + build + publish mcp-server's image                       ✅
13  docs: threat-model.md, new logging.md + mcp-server.md, CLAUDE.md, README.md               ✅
14  v1.9.0: add structured server logging and a log-reading MCP server                        ← next
```

Each slice's exclusions are everything below it — every later slice depends on an earlier one
(paths before the logger that uses them; the logger before wiring it in; wiring before the `lib/`
threading that needs a real logger to hand somewhere; the MCP server's pure logic before its HTTP
layer; both before the Docker/CI/docs slices that assume it exists).

## What "working" means, per slice

- **0** — this file exists, lists all 14 slices, exactly one `← next`.
- **1** — `logPath('x.log')` resolves under `logs/x.log`; existing path-helper tests still pass.
- **2** — a unit test can call the logger factory against a tmpdir, log a line, and find it on both
  a captured stdout stream and a rotated file there; `timed()` logs `{label, durationMs}` on
  success and re-throws with a logged error on failure.
- **3** — `npm run web` produces real NDJSON on stdout *and* under `logs/`; an `x-request-id`
  request header is echoed back verbatim, and an absent one gets a generated UUID in the response.
- **4** — `docker compose up --build` starts cleanly, `./logs` is writable by the container's user,
  and a fresh checkout's `logs/` directory pre-exists via a committed `.gitkeep` (no root-owned
  auto-created directory).
- **5–6** — every existing `test/*.test.js` still passes unchanged (CLI callers pass no `log`,
  default to `console`, identical behavior); a new test asserts a fake `log` object receives
  `.warn`/`.error` on the already-covered retry/failure paths.
- **7** — driving the running app (a confirm, a verify, a discovery run against a scratch DB) shows
  structured log lines for the underlying Wikidata/iNat/Commons calls, tagged with the same
  request id as the route that triggered them.
- **8** — `mcp-server`'s own `node --test` suite passes against fixture NDJSON files covering both
  dated and legacy filenames, the `current.log` symlink exclusion, and the date-range pre-filter.
- **9** — a raw authenticated `POST /mcp` against a manually-started instance gets a valid MCP
  response from at least one tool; a missing/wrong token gets 401/403; a disallowed Host header
  gets 403; `/healthz` needs neither.
- **10** — `docker compose up mcp-logs` (alongside `web`) starts, reads what `web` writes, and its
  own `/healthz` passes without touching `web` at all.
- **11** — Claude Code, given `.mcp.json` and the right env vars, lists the new server's six tools.
- **12** — CI's `test` job runs `mcp-server`'s suite; a new `build-and-push-mcp` job publishes its
  image on push to `main`.
- **13** — every doc a reader would hit while looking for this mentions it and cross-links the two
  new docs pages.
- **14** — `package.json` reads `1.9.0`; `git log --grep '^v[0-9]'` shows the closing commit.
