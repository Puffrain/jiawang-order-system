FROM node:20-bookworm-slim AS base
ENV PNPM_HOME="/pnpm" \
    PATH="${PNPM_HOME}:${PATH}"
RUN apt-get update \
    && apt-get install -y --no-install-recommends python3 make g++ \
    && rm -rf /var/lib/apt/lists/* \
    && corepack enable \
    && corepack prepare pnpm@9.15.4 --activate
WORKDIR /app

FROM base AS deps
COPY package.json pnpm-lock.yaml* ./
RUN pnpm install --frozen-lockfile

FROM deps AS builder
ARG NEXT_PUBLIC_BASE_PATH=/warehouse
ENV NEXT_PUBLIC_BASE_PATH=${NEXT_PUBLIC_BASE_PATH}
COPY . .
RUN pnpm build

# Small immutable web image. SQLite/media live in named Docker volumes mounted
# by compose; no host/OneDrive path is used for live state.
FROM node:20-bookworm-slim AS web
ENV NODE_ENV=production
ENV PORT=3000 HOSTNAME=0.0.0.0
WORKDIR /app
COPY --from=builder /app/.next/standalone ./
COPY --from=builder /app/.next/static ./.next/static
COPY --from=builder /app/public ./public
COPY --from=builder /app/migrations ./migrations
COPY --from=builder /app/package.json ./package.json
RUN mkdir -p /data/db /data/tmp /data/backups /media && chown -R node:node /app /data /media
USER node
EXPOSE 3000
CMD ["node", "server.js"]

# The worker uses the same dependency layer and source tree, but runs as a
# separate process/container so CPU-heavy jobs cannot block web requests.
FROM deps AS worker
ENV NODE_ENV=production
COPY . .
RUN mkdir -p /data/db /data/tmp /data/backups /media && chown -R node:node /app /data /media
USER node
CMD ["node", "--import", "tsx", "worker/index.ts"]
