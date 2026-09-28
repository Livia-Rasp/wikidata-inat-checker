# Decisions and their reasoning

Why the repository is set up the way it is, for things no other doc here records. Read this before
proposing to change any of it. Each entry is the decision and what decided it; where the full
reasoning lives in another doc, it points there.

## The image is public, and badged through a third-party service (2026-08-26)

The GHCR package is public, so anyone can pull the image without credentials. The README badge
comes from [`eggplants/ghcr-badge`](https://github.com/eggplants/ghcr-badge) (`ghcr-badge.egpl.dev`),
a third-party hosted service, because `shields.io` has no native GHCR support. **Accepted trade-off:**
a small external service renders one image on the README; nothing in the build or the app depends
on it.

## Going public on GitHub changed nothing the tool may do (2026-08-19)

Making the repository public is publishing, not deploying. The server stays loopback-only and
unauthenticated, and `threat-model.md` is the record of why that posture holds for the initial
deployment and no further.

- **The tracking category** (`Category:Media uploaded with wikidata-inat-checker`) is emitted again,
  last in the category list: it describes how the file arrived, not its subject
  (`web/js/commonsUpload.js`).
- **No backfill of that category was needed.** Checked 2026-08-26 against `data/findings.db`: no
  file had been uploaded through the app yet. Had there been, it could not be automated from this
  repository anyway — `lib/utils.js` only ever makes read-only Commons API calls, and there is no
  write or auth path here on purpose.
- **The docs are part of the showcase.** A stale `docs/` reads as carelessness about the code too.
  Audited 2026-08-26 for "private"/"not public" wording: every hit is about the server's loopback
  network posture, not the repository's visibility, and still holds.

## Structured logs, rotated to disk, with a request id on every line (v1.9.0, 2026-08-29)

Once beta testers other than the maintainer use the app, a bug cannot be diagnosed by having
watched the terminal. So `server/logger.js` adds a daily-rotated file destination (`pino-roll`,
`LOG_RETENTION_DAYS`, default 7) beside Fastify's stdout, every request carries an `x-request-id`
(honoured if sent, echoed back), and `timed()` logs the duration or the error of the two steps that
do real outbound work. `mcp-server/` reads those files. Design and the `pino-roll` retention
gotcha: `logging.md`.

## Type-checking and oxlint in CI, no Prettier (v1.6.0)

`npm run typecheck` (`tsc` over `jsconfig.json`, then `web/jsconfig.json` for browser-scoped
`checkJs`) and `npm run lint` (oxlint, `correctness` only) both gate CI. **No auto-formatter:** in a
sibling project Prettier rewrote 44 of 81 files, 557 changed lines, and caught no defect. Detail:
`dev.md`.
