# Deploying to the home server

The app on a LAN host that has Docker and nothing else: no Node, no checkout to build from. One
operator, reachable from the local network only. How beta testers get in is a later decision
(slice 9b in [build-plan.md](build-plan.md)), and nothing here pre-empts it.

It is the same `compose.yaml` that runs locally. What turns it into a LAN deployment is a
gitignored `.env` beside it; without that file the app binds loopback and discovery is off. What
the container is and why it is built that way is in [container.md](container.md); what the
exposure costs is in [threat-model.md](threat-model.md#deployment-posture-today).

## What the server needs

- Docker with the Compose plugin, and a user who may run it.
- The gallery's Watchtower, already running there. It redeploys any container carrying the
  `com.centurylinklabs.watchtower.enable` label when CI publishes a new image. Both images are
  public on GHCR, so no pull credential is involved.
- An address that does not change: a fixed DHCP lease, or the router's name for the host.

## First deployment

**1. A database snapshot, taken on the development machine.** `VACUUM INTO`, not a file copy: a
copy of a live WAL database can miss what is still in the `-wal` file.

```sh
npm run backup                                   # writes backups/findings-<timestamp>.db
scp backups/findings-<timestamp>.db <server>:    # the newest one
```

**2. The checkout and its directories, on the server.** The checkout is there for `compose.yaml`
and `.env.example` only — nothing is ever built from it.

```sh
git clone https://github.com/Livia-Rasp/wikidata-inat-checker.git && cd wikidata-inat-checker
mkdir -p data output cache backups
mv ~/findings-<timestamp>.db data/findings.db
id -u                                            # 1000, or set WINC_UID/WINC_GID in .env
```

The `mkdir` is not optional. Docker creates a missing bind-mount source as root, and the
container, running as uid 1000, then cannot write to it: the server exits with "unable to open
database file". `logs/` and `taxa-index/` are tracked, so they already exist.

**3. The two environment files.**

```sh
cp .env.example .env                             # then edit: WINC_ALLOWED_HOSTS
cp mcp-server/.env.example mcp-server/.env       # then edit: MCP_AUTH_TOKEN, ALLOWED_HOSTS
openssl rand -hex 32                             # a value for MCP_AUTH_TOKEN
```

`WINC_ALLOWED_HOSTS` and the MCP server's `ALLOWED_HOSTS` both need every name and address a
client will use for this host. Leave one out and requests made under that name are refused: the
app answers writes with `403 host_not_allowed`, the MCP server answers everything with 403.

**4. Start it.** Never with `--build`: that would build from the checkout instead of running the
image CI built and smoke-tested.

```sh
docker compose pull
docker compose up -d
docker compose ps                                # web: (healthy) within a few seconds
```

The app is now at `http://<server>:8080`, with the backlog from the snapshot.

**5. Build the taxa index.** Discovery, the scheduled top-up and taxon-scoped search need the
iNaturalist taxa index, and only a checker run builds it. The first one downloads about 190 MB:

```sh
docker compose run --rm cli checkImages.js --iucn CR --limit 200
```

The running server picks the index up without a restart.

**6. Backups, from the server's own crontab** (`crontab -e`, no root needed). `-T` because cron
has no terminal:

```sh
0 3 * * * cd ~/wikidata-inat-checker && docker compose run --rm -T cli tools/backup.mjs >> backups/backup.log 2>&1
```

**7. The log-reading MCP server, from the development machine.** `.mcp.json` reads both values
from the environment, so they go in the shell profile, not in the repository:

```sh
export WINC_LOGS_MCP_URL=http://<server>:3400/mcp
export WINC_LOGS_MCP_TOKEN=<the MCP_AUTH_TOKEN from step 3>
```

## The command-line tools on the server

The `cli` service runs any entry script from the same image, against the same `data/` the server
has open. It sits behind a compose profile, so `docker compose up` never starts it.

```sh
docker compose run --rm cli checkImages.js --taxon Orchidaceae --limit 500
docker compose run --rm cli checkLinks.js --limit 200
docker compose run --rm cli checkNames.js --iucn CR
docker compose run --rm cli verifyFindings.js
docker compose run --rm cli tools/backup.mjs --keep 30
```

Reports land in `output/` on the server. The big first fill of the backlog is a series of these,
scoped and spread over days; the app's own "Find more" and the daily top-up then keep it going.
`.env.example` scopes the top-up to `TOPUP_IUCN=CR`. Widen it deliberately: an unscoped top-up
walks the whole iNat index against Wikidata once a day per kind.

The index goes stale after 30 days. The next checker run through `cli` downloads and rebuilds it;
the app shows it as stale until then and keeps using it.

## Updating

- **A new image** arrives by itself: Watchtower polls GHCR, replaces the container, waits for its
  healthcheck and reports through the gallery's ntfy topic. There is no rollback; see below.
- **A change to `compose.yaml`, `.env.example` or this procedure** does not. Watchtower follows
  images, never compose files:

  ```sh
  git pull && docker compose up -d
  ```

- **An edit to `.env`** needs the same `docker compose up -d` to take effect.

## Rolling back

Every build is on GHCR under its commit sha and its version. Pin one in `.env`:

```sh
WINC_TAG=1.9.3          # or a full commit sha
```

then `docker compose up -d`. A pinned tag does not move, so Watchtower leaves the container alone
until the line is removed again. The database is not rolled back with it; a schema migration that
a newer image applied stays applied, so restore a backup from before the update if the older
image cannot read it.

## Restoring a backup

The server holds the file it opened at startup, so a restore needs a stop:

```sh
docker compose stop web
cp backups/findings-<timestamp>.db data/findings.db
rm -f data/findings.db-wal data/findings.db-shm
docker compose start web
```

## What to check on the first real run

Proved on a development machine before this was written: the container serving a LAN address
over plain http, writes and the area preview through the guard, the index build, a discovery run
and a backup through `cli`. What only the real server can show:

- [ ] `docker compose ps` shows both containers up, `web` healthy, after a **reboot** of the server.
- [ ] Requests in `logs/` carry the client's LAN address, not a `172.x` bridge address. If they
      show the bridge, every client shares one rate-limit bucket; see
      [threat-model.md](threat-model.md).
- [ ] A batch worked end to end from another machine: pick a photo, the Commons upload form,
      copy the QuickStatements, **Confirm pending**.
- [ ] Skip and Undo, the links review (Pick this one), the names page, search.
- [ ] The area page from a phone on the Wi-Fi: preview and **Add to worklist**.
- [ ] **Find more** from the app, and the run in the worklist afterwards.
- [ ] The next morning: a run with `triggeredBy: schedule` in `GET /api/discover/status`.
- [ ] A redeploy: merge something, and Watchtower's notification arrives.
- [ ] A backup file in `backups/` after 03:00, and a restore from it.
- [ ] The `winc-logs` MCP server answers from the development machine.

## Known limits of this posture

- **No authentication.** Anyone on the LAN can read the backlog and change the worklist. That is
  the accepted posture for one operator on a home network, and it is what 9b has to replace.
- **Plain http is not a secure context.** The browser withholds the Clipboard API and
  `crypto.randomUUID` (the app falls back for both) and sends no `Sec-Fetch-Site`, so the write
  guard relies on `Origin` for writes and on a required `X-Requested-With` header for
  `GET /api/discover/area`. Detail in [threat-model.md](threat-model.md).
- **The port binding is the only network control.** Docker publishes ports past ufw. `WINC_BIND`
  decides which interface serves, and the router decides what reaches the host.
- **Nothing watches the container between deploys.** Watchtower reports a failed update, not an
  app that turns unhealthy on a Tuesday afternoon.
