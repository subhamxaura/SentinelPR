# SentinelPR

**Autonomous PR Quality, Visual Regression & Synthetic Monitoring Platform**

SentinelPR connects code changes to user experience and production reliability. A developer opens a
pull request; SentinelPR inspects the diff, runs a deterministic rule engine (plus optional AI),
publishes a GitHub check run with inline comments, executes Playwright visual and DOM comparisons
against explicit baselines, and folds every signal into one explainable risk score. Separately,
scheduled synthetic monitors replay critical user journeys against deployed apps and raise alerts
with real latency percentiles and availability history.

It is designed to feel like the serious parts of GitHub Actions, Vercel, Linear, Datadog and
Playwright — as one coherent developer-infrastructure product.

---

## Architecture

Control plane / execution plane separation. The API orchestrates; workers execute; PostgreSQL holds
durable state; Redis carries queues and schedules; object storage holds large artifacts.

```
GitHub App webhook ──►  API (Next.js route handlers, Next 16 / React 19)
                            │
                            ├── PostgreSQL (Prisma 7, driver adapter)   ← durable state
                            └── Redis (BullMQ 6, job schedulers)        ← queues + cron
                                     │
             ┌───────────────────────┼───────────────────────────┐
             ▼                       ▼                           ▼
        Review worker           Visual worker               Synthetic worker
        (Octokit + rules        (Playwright capture,        (Playwright journey
        + optional AI →         pixelmatch diff,            executor, metrics,
        check run, comments,    DOM signature diff)         alerts)
        unified risk)
                                     │
                                     ▼
                    Artifacts (S3/MinIO or local FS driver)
                                     │
                                     ▼
                    Dashboard (dark, dense, JetBrains Mono for data)
```

Key invariants:

- **The API never executes arbitrary repository code.** Review reads diffs through the GitHub API;
  Playwright runs only in workers, against configured URLs.
- **Webhooks acknowledge fast.** Long-running analysis is always queued (BullMQ), never inline.
- **Everything is idempotent.** Webhook deliveries are deduplicated by delivery id; one review per
  head SHA; deterministic BullMQ job ids per run; workers are retry-safe.
- **Every metric is real.** The dashboard never fabricates numbers — empty states explain what is
  missing and how to fix it.

## Features

**PR review engine**
- GitHub App (installation tokens) or PAT fallback; webhook signature validation (HMAC-SHA256,
  constant-time); delivery idempotency; one review per head SHA.
- Deterministic rule engine: hardcoded secrets (AWS/GitHub/Slack/Google/JWT/private keys/generic
  assignments), eval, shell injection, dangerouslySetInnerHTML, committed .env, lifecycle scripts,
  empty catch, console.log, debugger, untracked TODOs, missing tests, forbidden imports.
- Optional AI enhancement (any OpenAI-compatible endpoint): focused hunks only, structured JSON
  output, zod-validated, confidence-gated, hallucination guard (findings restricted to files in the
  diff), never fatal to the pipeline.
- GitHub check run with category/risk summary + inline review comments (severity/confidence
  thresholds, max comments, deduped across runs of the same PR).

**Unified risk engine**
- Code risk + security risk + experience risk (visual/E2E) + production risk (synthetic health) →
  one level (none/low/medium/high/critical) with score and per-signal reasons. Explainable by
  construction — the UI always shows the contributing signals.

**Visual regression**
- Playwright capture (Chromium/Firefox/WebKit, device profiles, reduced-motion + animation freeze
  for determinism), pixelmatch comparison with per-test thresholds, changed-region localization,
  PNG diff artifacts, and a DOM "experience signature" diff (missing controls, heading changes,
  title changes) that catches regressions pixels miss.
- Baselines are explicit and versioned: first captures are candidates; "Approve as baseline" is a
  deliberate action that bumps the version. Runs never silently replace baselines.
- Side-by-side / overlay / diff viewer with zoom and artifact URLs signed with expiring tokens.

**Synthetic monitoring**
- Step vocabulary: navigate, click, fill, press, select, wait, assert_text, assert_visible,
  assert_url, screenshot, request (API checks). Validated with zod at creation and execution.
- BullMQ job schedulers (upsert/pause/resume, startup reconciliation from the DB as source of
  truth), duplicate-tick prevention, retry/backoff, timeouts.
- Metrics: availability, P50/P95/P99, average, consecutive failures. Alerts on failure, consecutive
  failures, latency threshold; auto-resolve on recovery. In-app + outgoing webhook channels.

**Multi-tenant auth & team management**
- GitHub OAuth sign-in with server-side sessions: HttpOnly cookie, token stored only as a SHA-256
  digest, signed expiring OAuth state, 7-day sliding expiry, org switching.
- Organizations with owner > admin > member roles: members read; only admins mutate. Every
  mutating API route is role-checked and audit-logged with the acting user.
- Closed-loop onboarding from the **Team** page: invite members by GitHub verified email, approve
  or deny self-serve access requests, edit or revoke roles — with owner protection (owners are
  immutable; the last owner cannot be demoted or removed).
- GitHub App installations arrive unclaimed via webhook and are bound to exactly one organization
  by an explicit admin claim that backfills their repositories.

**Dashboard**
- Overview, Pull Requests (+ rich per-PR detail with risk breakdown and findings), Visual suites
  and comparison viewer, Synthetic monitors (journey builder, metrics, history), unified Runs,
  Alerts, Repositories (with manual review trigger), Team, Rules registry, Settings with honest
  configuration state (Redis live probe, webhook delivery ledger, job history).
- Command palette (⌘K / `/`), `g`-prefixed keyboard navigation, dark zinc/indigo design system,
  responsive, keyboard-accessible.

## Stack

Next.js 16 (App Router) · React 19 · TypeScript (strict) · Tailwind CSS 4 · Prisma 7 (PostgreSQL,
driver adapters) · BullMQ 6 + ioredis · Octokit 5 · Playwright · pixelmatch + pngjs ·
@aws-sdk/client-s3 (MinIO/S3/R2) · zod · Vitest.

## Quick start (local development)

Prerequisites: Node 20+, pnpm 10+, Docker (for Postgres/Redis/MinIO), a GitHub App or PAT for
review features.

```bash
pnpm install
cp .env.example .env          # fill in what you have; the dashboard shows what's missing
docker compose up -d          # postgres + redis + minio (+ bucket bootstrap)
pnpm db:migrate               # apply schema (pnpm db:migrate:dev to author new migrations)
pnpm dev                      # dashboard on http://localhost:3000
```

In separate terminals, start the workers (each is an independent process; run the ones you need):

```bash
pnpm worker:review
pnpm worker:visual
pnpm worker:synthetic
```

Playwright browsers (first run): `pnpm exec playwright install chromium` (or `--with-deps` on Linux).

### 60-second smoke test without GitHub

Visual + synthetic need no GitHub credentials:

1. Dashboard → **Synthetic Monitoring** → *New monitor* → base URL `https://example.com`, steps
   `[{"type":"navigate","url":"/"},{"type":"assert_text","selector":"h1","text":"Example Domain"},{"type":"screenshot"}]`,
   schedule `*/5 * * * *` → *Run now*.
2. Watch the run, step results, screenshot, and metrics land in real time. (Local URLs need
   `SENTINEL_ALLOW_PRIVATE_TARGETS=1`.)
3. **Visual Regression** → *New suite* pointing at any URL → add a test → *Run* → approve the
   baseline → change the page → run again → inspect the diff.

## User sign-in (OAuth)

Out of the box the dashboard runs in local single-operator mode (no auth, localhost only). For
multi-user access:

1. Create a GitHub **OAuth App** at <https://github.com/settings/developers> with callback
   `{DASHBOARD_URL}/api/auth/github/callback`.
2. Set `AUTH_GITHUB_CLIENT_ID` and `AUTH_GITHUB_CLIENT_SECRET` (mode auto-switches to OAuth), or
   pin `SENTINEL_AUTH_MODE=oauth`. Set a strong `AUTH_STATE_SECRET` in production.
3. The first signed-in user becomes owner of the default organization; further users auto-join as
   members (or require invites/requests when `AUTH_ALLOW_DEFAULT_ORG_SIGNUP=0`). Manage the team on
   `/team`.

See [docs/configuration.md](docs/configuration.md) and [docs/security-model.md](docs/security-model.md).

## GitHub App setup

See [docs/github-app-setup.md](docs/github-app-setup.md) for the full walkthrough (manifest flow,
permissions, webhook secret, private key env encoding). Short version:

1. Create an app at `https://github.com/settings/apps/new` with webhook URL
   `https://<your-host>/api/github/webhook`, secret, and the permissions listed in the doc.
2. Set `GITHUB_APP_ID`, `GITHUB_APP_SLUG`, `GITHUB_APP_PRIVATE_KEY` (PEM or base64), `GITHUB_WEBHOOK_SECRET`.
3. Install on repositories — `installation` / `installation_repositories` webhooks register them
   automatically; PRs start flowing through the review pipeline.

## Environment variables

Every variable is documented with defaults in [.env.example](.env.example). Highlights:

| Variable | Required | Purpose |
| --- | --- | --- |
| `DATABASE_URL` | yes | PostgreSQL connection |
| `REDIS_URL` | yes (queues/workers) | BullMQ connection |
| `DASHBOARD_URL` | recommended | used in check-run links |
| `GITHUB_APP_ID` / `GITHUB_APP_PRIVATE_KEY` / `GITHUB_WEBHOOK_SECRET` | for webhooks | GitHub App |
| `GITHUB_TOKEN` | optional | PAT fallback for manual review runs |
| `AI_PROVIDER` / `AI_API_KEY` / `AI_BASE_URL` / `AI_MODEL` | optional | AI review enhancement |
| `ARTIFACT_DRIVER` (`local`\|`s3`) + `S3_*` | yes | artifact storage backend |
| `ARTIFACT_TOKEN_SECRET` | recommended | signing key for artifact URLs |
| `SENTINEL_ALLOW_PRIVATE_TARGETS` | dev only | allow localhost targets for visual/synthetic |
| `ALERT_WEBHOOK_URL` | optional | outgoing alert fan-out |

## Deployment

One image runs everything — dashboard, workers, or migrations — selected by the container command:

```bash
docker build -t sentinelpr .
docker compose --profile app up -d   # full local stack: infra + migrations + app + workers
```

The image includes Chromium for the visual/synthetic workers. Managed Postgres/Redis/S3 work out of
the box (connection-string URLs only). See [docs/deployment.md](docs/deployment.md) for the
production topology, secrets, and hardening checklist.

## Testing & verification

```bash
pnpm test        # unit tests: rule engine, risk engine, patch parsing, webhook signature
                 # validation + idempotency policy, DOM diff, pixel diff, percentiles, SSRF
                 # ranges, artifact tokens, finding normalization/dedupe
pnpm typecheck   # strict TS across app + workers
pnpm build       # production build of the dashboard
```

Workers, webhook flow and Playwright execution are integration-tested against real infrastructure
(docker compose services) — see the CI workflow which runs typecheck → unit tests → migrations →
build with Postgres and Redis services.

## Security model

See [docs/security-model.md](docs/security-model.md). Summary:

- PR code is untrusted and is never executed — the review engine only reads diffs via the API.
- Webhook signature validation, delivery idempotency, and fast-ack response contract.
- **Multi-user OAuth**: GitHub sign-in with server-side sessions (HttpOnly cookie, hashed token at
  rest, signed expiring OAuth state), organization memberships with owner/admin/member roles, and
  member-level write protection on every mutating API route.
- SSRF guard on every user-supplied URL (scheme allowlist, localhost/metadata hostname blocklist,
  DNS resolution + private-range rejection, documented DNS-rebinding limitation).
- Secrets never reach the client bundle; artifact access only via signed, expiring URLs;
  org-scoped queries enforced server-side on every route and page.
- Workers are separate processes with concurrency limits, timeouts and structured logging with
  secret redaction.

## Limitations (honest)

- **Auth modes**: OAuth mode enables true multi-user access; without `AUTH_GITHUB_CLIENT_ID`/
  `SECRET` the dashboard runs in local single-operator mode with no sign-in (localhost only).
  Roles are org-global (no per-resource ACLs); ownership transfer is promote-then-self-demote.
- **Local preview builds**: suites target running URLs; building/starting untrusted PR code
  locally is deliberately not wired (secure boundary, documented).
- **DNS rebinding**: the SSRF guard checks at request time; a pinned-connection client is the
  complete fix (documented).
- Without Docker/Redis/Postgres, the UI runs with explicit "configuration required" states instead
  of pretending — by design.

## Scripts

| Command | Purpose |
| --- | --- |
| `pnpm dev` | Dashboard dev server |
| `pnpm build` / `pnpm start` | Production build / serve |
| `pnpm worker:review` / `worker:visual` / `worker:synthetic` | Workers |
| `pnpm db:migrate` / `db:migrate:dev` / `db:studio` / `db:generate` | Prisma |
| `pnpm test` / `typecheck` | Verification |

## Docs

- [Deployment guide](docs/deployment.md)
- [GitHub App setup](docs/github-app-setup.md)
- [Security model](docs/security-model.md)
- [Visual baselines](docs/visual-baselines.md)
- [Synthetic monitoring & scheduling](docs/synthetic-monitoring.md)
- [Configuration reference](docs/configuration.md)

## Contributing & security

PRs welcome — see [CONTRIBUTING.md](CONTRIBUTING.md) for setup, architecture map, and the review
checklist. Security vulnerabilities: please use private reporting per [SECURITY.md](SECURITY.md),
not public issues.

## License

[MIT](LICENSE)

## Demo script (portfolio)

1. Connect a repo via the GitHub App → open a PR with a hardcoded secret → webhook → review runs →
   inline comment + check run shows risk HIGH → alert created.
2. Fix it in a new commit → `synchronize` → re-review → risk drops, comment deduped (no spam).
3. Visual suite against a preview URL → first run creates baseline candidates → approve → break the
   UI → run → red diff + changed regions + DOM "missing control" observation → risk signals update.
4. Synthetic monitor on a critical journey → kill the endpoint → failures + consecutive-failure
   alert → restore → auto-resolved alert + availability recovery curve.
5. Overview ties it together: one explainable risk story across code, experience, production.
