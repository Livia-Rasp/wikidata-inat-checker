# Running it in a container

```sh
docker compose up --build     # then open http://localhost:8080
```

`docker compose up` runs the server only. The server never builds the taxa index that discovery
needs — a run started without it fails in milliseconds — but the same image can: the checkers
run from it through the `cli` service, below. Discovery itself, once that index exists, works
normally through the published port (slice 10) — see "Two limits worth knowing" below for what
that means in practice. The reasons for both are in [threat-model.md](threat-model.md).

It bind-mounts `./data`, so the container and your host share one database. Run `npm run images`
on the host and the new findings appear without a restart. The published port is bound to the
host's loopback, so `docker compose up` does not put an unauthenticated API on your network.
Serving a LAN from a host that has only Docker is the same file plus a `.env`:
[deployment.md](deployment.md).

## If your uid is not 1000

A bind mount keeps the host's ownership, so the container has to run as whoever owns `./data`.
Otherwise it exits with "unable to open database file". Start it as yourself:

```sh
WINC_UID=$(id -u) WINC_GID=$(id -g) docker compose up --build
```

## Two limits worth knowing

**"Find more" and the area page's Add to worklist now work from the host browser.** Cost used to be
bounded by requiring a request from the server's own machine — which a published port could never
satisfy, since the container always sees the bridge gateway as the peer, never real loopback. Slice
10 replaced that with an hourly-refilling token budget instead (see
[threat-model.md](threat-model.md)'s "Discovery budget" section), so it no longer matters where the
request comes from, only how much of the budget is left. **The area page's Preview button is the
one exception** — it still needs the same `costsBudget` write-guard checks (Host allowlist,
same-origin) any of these routes get, but is otherwise ordinary now too. All three still need
`DISCOVER_ENABLED=1`, and none of them can build the taxa index — see below.

**The iNaturalist taxa index is not in the image.** That is ~236 MB of derived data, and only the
CLI may build it. Without it, discovery fails immediately (`taxa_index_unavailable`) but the app
still serves everything else — search falls back to name matching rather than failing. The
server looks for it in `./taxa-index` (`WINC_TAXA`), mounted read-only, and a checker run through
the `cli` service puts it there; once it exists, discovery through the app works normally with no
restart.

That directory is deliberately not `~/.cache/wikidata-inat-checker`, where a checker run on the
host keeps its index: Docker creates a missing bind-mount source as root, so defaulting to the
host's cache would break the host CLI on any machine that had not built an index yet. To share
one index between both, set `WINC_TAXA=$HOME/.cache/wikidata-inat-checker`.

## The checkers, from the image

```sh
docker compose run --rm cli checkImages.js --iucn CR --limit 500
docker compose run --rm cli verifyFindings.js
docker compose run --rm cli tools/backup.mjs
```

`cli` is the same image with `node` as its entrypoint, behind a compose profile so `up` never
starts it. It mounts `data/`, `output/`, `cache/`, `backups/` and the taxa index read-write —
create the first four before the first run, or Docker creates them as root. It exists for a host
with no Node; where Node 26 is installed, `npm run images` against the same `./data` does the
same thing. `tools/backup.mjs` is the one file from `tools/` the image carries.

## The published image

CI publishes to `ghcr.io/livia-rasp/wikidata-inat-checker` on every push to `main`, tagged three
ways: `latest`, the `package.json` version, and the commit sha. Each answers a different question —
"the current one", "the release I would name out loud", and "exactly this build".

The package is public, so it pulls without authentication:

```sh
docker pull ghcr.io/livia-rasp/wikidata-inat-checker:latest
```

The image is built, started and smoke-tested in CI before it is pushed, so a published tag has
always served a request and shut down cleanly. See
[`.github/workflows/ci.yml`](../.github/workflows/ci.yml).

## The log-reading MCP server

`compose.yaml` also defines `mcp-logs` — a separate, read-only container over the same `./logs`
bind mount `web` writes into, exposing six log-query tools to an MCP client (Claude Code, or any
other) over Streamable HTTP. Full design, its own env vars and its own threat model are in
[mcp-server.md](mcp-server.md); `mcp-server/.env.example` has the copy-and-fill instructions.
Published the same way as `web`'s own image, to `ghcr.io/livia-rasp/wikidata-inat-checker-mcp`.

## Redeploying automatically

Both the `web` and `mcp-logs` services in `compose.yaml` carry
`com.centurylinklabs.watchtower.enable=true`, but this repo does **not** run its own Watchtower —
it relies on the one `vue-commons-gallery` already runs on the home server it shares, polling GHCR
for any labelled container. One poller per host, not one per project. If that other repo's
Watchtower isn't running on wherever this gets deployed, the label alone buys nothing; redeploys
then need `docker compose pull && docker compose up -d` by hand.

**Never `docker compose up --build` on the server itself** — that rebuilds from whatever source
happens to be checked out there, not the image CI already built and smoke-tested. `build: .` in
`compose.yaml` is local-dev convenience only.

## Backing the database up

```sh
npm run backup                 # writes backups/findings-<timestamp>.db, prunes to the last 14
npm run backup -- --keep 30    # a different retention count
```

Runs beside the server, against `data/findings.db` directly — from the host, or on a host without
Node as `docker compose run --rm -T cli tools/backup.mjs`. Either way the timer is the host's:
the container has no cron. This is the same two-process-one-file arrangement the CLI
checkers already use: `VACUUM INTO` takes a read lock and produces a consistent snapshot regardless
of what else is writing to the file at the time, so it's safe to run on a timer without stopping
anything first. Add it to the host's crontab once this is actually deployed somewhere:

```sh
0 3 * * * cd /path/to/wikidata-inat-checker && npm run backup >> backups/backup.log 2>&1
```

**Restoring needs a restart.** The running server holds an open connection to the file it opened at
startup, so copying a backup over `data/findings.db` is invisible to it until it restarts:

```sh
docker compose stop
cp backups/findings-<timestamp>.db data/findings.db
docker compose start
```

## Not yet decided

Access for anyone beyond the operator — a VPN/Tailscale hop, a reverse proxy with access control,
or per-tester tunnels — is still an open question (slice 9b). What is decided is the step before
it: one operator, on the LAN, over plain http ([deployment.md](deployment.md)). This page's
defaults are still loopback-only. See [build-plan.md](build-plan.md) for the state of the plan,
and [threat-model.md](threat-model.md) for what each posture protects against.
