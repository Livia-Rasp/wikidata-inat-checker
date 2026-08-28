# The log-reading MCP server (mcp-server/) in a container — read-only over the logs/ directory
# the main app's `web` service writes. See docs/mcp-server.md.
#
# Single stage, deliberately, same reasoning as the root Dockerfile: no build step, so nothing
# here needs a compiler toolchain to drop. Built with `mcp-server` itself as the build context
# (compose.yaml's `build: ./mcp-server`) since this package has its own package.json/lockfile and
# needs nothing from the repo root.
FROM node:26.7.0-trixie-slim

ENV NODE_ENV=production \
    HOME=/home/node

WORKDIR /app

# Lockfile first, same reproducible-layer reasoning as the root Dockerfile.
COPY --chown=node:node package.json package-lock.json ./
RUN --mount=type=cache,target=/root/.npm npm ci --omit=dev

COPY --chown=node:node . .

# No mkdir/chown here, unlike the root Dockerfile: this process writes nothing at runtime — the
# log directory it reads is bind-mounted read-only (compose.yaml), and that mount's ownership is
# whatever the host side already has.
USER node

EXPOSE 3400

# node's own fetch rather than curl, which this image does not have — same approach the root
# Dockerfile's compose-level healthcheck uses. Unauthenticated and outside the Host allowlist by
# design (main.js/http.js), so this needs neither a token nor ALLOWED_HOSTS to succeed.
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
    CMD node -e "fetch('http://127.0.0.1:3400/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# Exec form: no shell between Docker and Node, so SIGTERM reaches the process directly.
CMD ["node", "main.js"]
