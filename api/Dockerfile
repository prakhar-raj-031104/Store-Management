# Multi-stage build:
#   1. web-builder  → npm ci + vite build → web/dist
#   2. api-deps     → npm ci --omit=dev (production deps only)
#   3. runtime      → node:slim with API source, prisma, and the built SPA
#
# The runtime image serves the API on /api/* and the SPA on everything else,
# so one container = full app.

# ---- 1. Build the web SPA ----
FROM node:20-slim AS web-builder
WORKDIR /web
COPY web/package.json web/package-lock.json ./
RUN npm ci
COPY web/ ./
RUN npm run build

# ---- 2. Install production API deps + generate Prisma client ----
# Use the full Debian image (not -slim) so openssl + ca-certificates are
# already present — Prisma's query engine needs them at runtime and we
# avoid an `apt-get` step that can flake on restricted networks.
FROM node:20-bookworm AS api-deps
WORKDIR /api
COPY api/package.json api/package-lock.json ./
COPY api/prisma ./prisma
RUN npm ci --omit=dev \
 && npx prisma generate

# ---- 3. Runtime ----
FROM node:20-bookworm-slim AS runtime
ENV NODE_ENV=production
ENV PORT=4000
WORKDIR /app

# Prisma's query + schema (migration) engines are dynamically linked against
# OpenSSL. The -slim image doesn't ship it, so without this Prisma falls back
# to "openssl-1.1.x" and the schema engine fails to start ("Schema engine error")
# when running `prisma migrate deploy` on boot. Install it so Prisma detects
# OpenSSL 3.0.x (matching the debian-openssl-3.0.x engine generated above).
RUN apt-get update -y \
 && apt-get install -y --no-install-recommends openssl ca-certificates \
 && rm -rf /var/lib/apt/lists/*

# API source + deps + generated Prisma client
COPY api/package.json api/package-lock.json ./
COPY api/prisma ./prisma
COPY api/src ./src
COPY --from=api-deps /api/node_modules ./node_modules

# Built SPA, served by Express in production
COPY --from=web-builder /web/dist ./public

# Run as the unprivileged `node` user that ships with the official image.
RUN chown -R node:node /app
USER node

EXPOSE 4000
HEALTHCHECK --interval=30s --timeout=5s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||4000)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# docker-compose.prod.yml sets `init: true` so the container gets a proper
# PID 1 (no need for dumb-init in the image). Apply pending migrations on
# boot, then start the server.
CMD ["sh", "-c", "npx prisma migrate deploy && node src/server.js"]
