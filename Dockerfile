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

# ── Runtime: full node_modules (workers need Playwright, BullMQ, SDKs) ───────
FROM base AS runner
WORKDIR /app
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    ARTIFACT_LOCAL_DIR=/app/.data/artifacts

# Manifests first (corepack reads packageManager), then dependencies.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY --from=build /app/node_modules ./node_modules

# Playwright system libraries + Chromium so the visual/synthetic workers are
# ready on first boot. Runs after node_modules so `pnpm exec` can resolve it.
RUN apt-get update \
 && apt-get install -y --no-install-recommends openssl ca-certificates \
 && pnpm exec playwright install --with-deps chromium \
 && rm -rf /var/lib/apt/lists/*

COPY --from=build /app/.next ./.next
# Full src tree: workers execute TypeScript directly via tsx at runtime.
COPY --from=build /app/src ./src
COPY --from=build /app/prisma ./prisma
COPY --from=build /app/public ./public
COPY --from=build /app/next.config.ts ./next.config.ts
COPY --from=build /app/prisma.config.ts ./prisma.config.ts
COPY --from=build /app/tsconfig.json ./tsconfig.json
COPY --from=build /app/postcss.config.mjs ./postcss.config.mjs

EXPOSE 3000

# Dashboard by default:  docker run sentinelpr
# Workers:               docker run sentinelpr pnpm worker:review  (or :visual / :synthetic)
# Migrations:            docker run sentinelpr pnpm db:migrate
CMD ["pnpm", "start"]
