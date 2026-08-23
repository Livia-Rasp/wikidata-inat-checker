# Running it in a container

```sh
docker compose up --build     # then open http://localhost:8080
```

The image runs the server only. No checkers run inside it, and discovery cannot start there. The
reasons are in [threat-model.md](threat-model.md).

It bind-mounts `./data`, so the container and your host share one database. Run `npm run images`
on the host and the new findings appear without a restart. The published port is bound to the
host's loopback, so `docker compose up` does not put an unauthenticated API on your network.

## If your uid is not 1000

A bind mount keeps the host's ownership, so the container has to run as whoever owns `./data`.
Otherwise it exits with "unable to open database file". Start it as yourself:

```sh
WINC_UID=$(id -u) WINC_GID=$(id -g) docker compose up --build
```

## Two limits worth knowing

**"Find more", and the area page's Preview and Add to worklist, do not work from the host
browser.** All three are privileged routes that require a request from the server's own machine.
Through a published port the container sees the bridge gateway instead. Fill the backlog with the
CLI, which is what it is for.

**The iNaturalist taxa index is not in the image.** That is ~236 MB of derived data, and only the
CLI may build it. Without it the app still serves everything. Search falls back to name matching
rather than failing.

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

Redeploying automatically and backing the database up are the next slice. See
[findings-db-roadmap.md](findings-db-roadmap.md).
