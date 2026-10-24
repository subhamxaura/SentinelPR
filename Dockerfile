# syntax=docker/dockerfile:1

# ── Base: Debian (glibc) — Playwright browsers require it; corepack for pnpm ──
FROM node:22-bookworm-slim AS base
ENV PNPM_HOME=/pnpm \
    PATH="/pnpm:${PATH}"
RUN corepack enable

# ── Dependencies (cached layer) ──────────────────────────────────────────────
FROM base AS deps
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile

# ── Build: prisma client + production dashboard bundle ───────────────────────
FROM base AS build
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN pnpm db:generate && pnpm build

# ── Runtime: dedicated non-root user (node) ──────────────────────────────────
FROM base AS runner
WORKDIR /app
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    PLAYWRIGHT_BROWSERS_PATH=/ms-playwright \
    ARTIFACT_LOCAL_DIR=/app/.data/artifacts

# System libraries for Chromium & ca-certificates
RUN apt-get update \
 && apt-get install -y --no-install-recommends openssl ca-certificates \
 && rm -rf /var/lib/apt/lists/*

# Manifests first, then node_modules
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY --from=build /app/node_modules ./node_modules

# Install Playwright browser to /ms-playwright with system dependencies
RUN mkdir -p /ms-playwright /app/.data/artifacts \
 && pnpm exec playwright install --with-deps chromium \
 && chown -R node:node /app /ms-playwright /pnpm

COPY --from=build --chown=node:node /app/.next ./.next
COPY --from=build --chown=node:node /app/src ./src
COPY --from=build --chown=node:node /app/prisma ./prisma
COPY --from=build --chown=node:node /app/public ./public
COPY --from=build --chown=node:node /app/next.config.ts ./next.config.ts
COPY --from=build --chown=node:node /app/prisma.config.ts ./prisma.config.ts
COPY --from=build --chown=node:node /app/tsconfig.json ./tsconfig.json
COPY --from=build --chown=node:node /app/postcss.config.mjs ./postcss.config.mjs

USER node

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "fetch('http://localhost:3000/api/session').then(r => process.exit(r.ok || r.status === 401 ? 0 : 1)).catch(() => process.exit(1))"

# Dashboard by default:  docker run sentinelpr
# Workers:               docker run sentinelpr pnpm worker:review  (or :visual / :synthetic)
# Migrations:            docker run sentinelpr pnpm db:migrate
CMD ["pnpm", "start"]
