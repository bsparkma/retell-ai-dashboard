# CareIN backend (Express, CommonJS) — lean multi-stage image.
#
# Phase 3 Step 1 (containerization). This image runs ONLY the API server
# (backend/server.js) — it does NOT serve the SPA. The built dashboard is served
# by a separate front (Caddy locally / Azure Front Door in cloud) that also
# reverse-proxies /api, /auth and /socket.io back to this container. That keeps
# the API image single-responsibility and matches the cloud topology.
#
# Node 22-alpine matches the dev/prod host (node v22.x). The app is plain
# CommonJS, so there is no build/transpile step — the "build" stage only
# installs production dependencies into a clean layer that the runtime copies.

# ---- deps: install production node_modules in an isolated layer -------------
FROM node:22-alpine AS deps
WORKDIR /app

# Puppeteer (a dependency used by the Mango portal scraper) tries to download a
# ~150MB Chromium on install. The parity/API container never scrapes, so skip
# it — keeps the image lean and the build offline-friendly. If Mango scraping is
# ever containerized, build a separate image with Chromium + its libs.
ENV PUPPETEER_SKIP_DOWNLOAD=true \
    PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true

COPY package*.json ./
RUN npm ci --omit=dev --no-audit --no-fund

# ---- runtime: copy deps + source, run as non-root --------------------------
FROM node:22-alpine AS runtime
WORKDIR /app

ENV NODE_ENV=development \
    PUPPETEER_SKIP_DOWNLOAD=true

# Production deps from the deps stage (no dev tooling in the final image).
COPY --from=deps /app/node_modules ./node_modules

# Application source. .dockerignore keeps node_modules/.env/data out of context.
COPY . .

# server.js writes the append-only access log + unified-call store to ../data
# (resolves to /data with WORKDIR=/app). Create it and hand it to the non-root
# `node` user so the process can write without running as root. /app stays
# root-owned but world-readable (COPY defaults), which the node user can read —
# only the writable /data needs the chown. A compose volume mounts here for
# persistence.
RUN mkdir -p /data && chown node:node /data
USER node

# Default API port for the container (overridden by PORT in the env file).
ENV PORT=5403
EXPOSE 5403

# busybox wget ships with alpine — no extra package needed for the health probe.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD wget -qO- "http://127.0.0.1:${PORT}/api/health" >/dev/null 2>&1 || exit 1

CMD ["node", "server.js"]
