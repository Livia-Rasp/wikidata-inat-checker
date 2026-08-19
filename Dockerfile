# The web server (`npm run web`) in a container. Runtime only — this image does not run the
# checkers, and cannot: see compose.yaml and docs/threat-model.md for what a container can and
# cannot do here.
#
# Single stage, deliberately. Multi-stage exists to drop a compiler toolchain or build artifacts;
# this project has neither. `node:sqlite` is built into Node, so nothing compiles — which is also
# why the image needs no build-essential, no node-gyp and no Python.
#
# Debian trixie slim rather than Alpine. The usual reason to want Alpine (avoiding a toolchain for
# native modules) does not apply, and the reason against it does: node:26-alpine installs from
# unofficial-builds.nodejs.org, and on arm64 its Dockerfile has no checksum and falls through to
# compiling V8 from source. Node classes musl as an experimental platform and does not gate its
# CI on it. That is a poor trade for ~120 MB.
#
# The tag is pinned to a patch because Node 26 is not LTS until 2026-10-28 and moves quickly.
FROM node:26.7.0-trixie-slim

# HOME is load-bearing, not decoration: lib/getInatTaxaDb.js resolves its cache directory through
# os.homedir(), which throws for a UID with no passwd entry and no HOME. There is no environment
# override for that path, so the failure would be an import-time crash rather than the graceful
# "no taxa index" degradation the app is designed for.
ENV NODE_ENV=production \
    HOME=/home/node

WORKDIR /app

# Lockfile first: it changes far less often than source, so the install layer survives ordinary
# edits. npm ci wipes node_modules and refuses to run if package.json and the lockfile disagree,
# which is exactly what a reproducible image wants.
#
# Deliberately no `--mount=type=cache` on the install: that needs BuildKit, and this must build on
# the classic builder too (Docker without the buildx plugin is a normal state of affairs). The
# saving would be a fraction of a second on 77 packages — a bad trade for a Dockerfile that fails
# to build on someone else's machine.
COPY --chown=node:node package.json package-lock.json ./
RUN npm ci --omit=dev

COPY --chown=node:node . .

# Create and own the mount point while still root, then drop privileges. `node` is uid/gid 1000 in
# the official images. The directory must be writable, not merely the database file: WAL creates
# -wal and -shm beside it, and a read-only directory breaks WAL even for readers.
RUN mkdir -p /app/data && chown node:node /app/data
USER node

EXPOSE 8080

# Exec form, so no shell sits between Docker and Node and SIGTERM reaches the process that has a
# handler for it (server/index.js drains, stops any child, closes the database, exits 0).
# Never `npm start` here — npm swallows signals and the container would be SIGKILLed instead.
CMD ["node", "server/index.js"]
