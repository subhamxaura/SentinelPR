#!/usr/bin/env bash
# One-shot repository metadata setup for GitHub (requires the gh CLI and auth).
#
#   ./scripts/github-repo-setup.sh owner/sentinelpr
#
# Idempotent: safe to re-run. Nothing is pushed or overwritten in the repo
# itself — this only sets the listing metadata on GitHub.
set -euo pipefail

REPO="${1:?Usage: $0 owner/repo}"

DESCRIPTION="Autonomous PR review, visual regression & synthetic monitoring — one explainable risk score, multi-tenant dashboard. Next.js 16 · Playwright · BullMQ · Prisma"

gh repo edit "$REPO" \
  --description "$DESCRIPTION"

gh repo edit "$REPO" \
  --add-topic code-review \
  --add-topic pr-review \
  --add-topic static-analysis \
  --add-topic visual-regression \
  --add-topic synthetic-monitoring \
  --add-topic playwright \
  --add-topic e2e-testing \
  --add-topic bullmq \
  --add-topic nextjs \
  --add-topic prisma \
  --add-topic typescript \
  --add-topic risk-scoring \
  --add-topic developer-tools \
  --add-topic monitoring

echo "Repository metadata updated: $REPO"
echo "  description: $DESCRIPTION"
echo "  topics:      code-review, pr-review, static-analysis, visual-regression,"
echo "               synthetic-monitoring, playwright, e2e-testing, bullmq, nextjs,"
echo "               prisma, typescript, risk-scoring, developer-tools, monitoring"
