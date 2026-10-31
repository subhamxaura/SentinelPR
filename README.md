<div align="center">

# SentinelPR

**Autonomous PR Quality, Visual Regression & Synthetic Monitoring Platform**

[![Next.js](https://img.shields.io/badge/Next.js-16.4-black?style=flat-square&logo=next.js)](https://nextjs.org/)
[![React](https://img.shields.io/badge/React-19-blue?style=flat-square&logo=react)](https://react.dev/)
[![TypeScript](https://img.shields.io/badge/TypeScript-Strict-3178C6?style=flat-square&logo=typescript)](https://www.typescriptlang.org/)
[![Prisma](https://img.shields.io/badge/Prisma-7.0-2D3748?style=flat-square&logo=prisma)](https://www.prisma.io/)
[![BullMQ](https://img.shields.io/badge/BullMQ-6.0-CC292B?style=flat-square&logo=redis)](https://bullmq.io/)
[![Playwright](https://img.shields.io/badge/Playwright-E2E-2EAD33?style=flat-square&logo=playwright)](https://playwright.dev/)
[![Vitest](https://img.shields.io/badge/Vitest-5.0-FCC72B?style=flat-square&logo=vitest)](https://vitest.dev/)
[![License: MIT](https://img.shields.io/badge/License-MIT-emerald?style=flat-square)](LICENSE)

*Connecting pull request diffs, multi-signal risk analysis, Playwright visual baselines, and 24/7 synthetic monitoring into a single explainable verdict.*

---

</div>

## Overview

Modern engineering teams often fragment their reliability tooling across disparate SaaS silos: static analysis in one vendor, visual regression in another, synthetic monitoring in a third, and PR check runs in GitHub. 

**SentinelPR** unites these disciplines into a coherent, self-hostable developer-infrastructure platform. When a developer opens a pull request, SentinelPR:

1. **Ingests & Secures**: Cryptographically verifies GitHub App webhooks via HMAC-SHA256, blocks SSRF/DNS-rebinding attacks, and buffers work through a transactional PostgreSQL outbox.
2. **Evaluates Risk**: Runs deterministic AST rules, scans for secret leaks with Shannon entropy, and correlates live production P95 latency percentiles to calculate an explainable 0–100 risk score.
3. **Verifies Visuals**: Uses headless Chromium to capture pixel snapshots against versioned, immutable baselines while diffing the DOM signature for missing headings and controls.
4. **Monitors Production**: Replays synthetic user journeys 24/7 with real-time latency percentiles (P50/P95/P99), dispatching auto-resolving alerts across webhooks.
5. **Enforces Enterprise Standards**: Operates with fail-closed OAuth authentication, Redis sliding-window rate limiting, serializable ownership protections, and automated DB/S3 artifact retention.

---

## Architecture

SentinelPR enforces a strict separation between the **control plane** (web dashboard and API route handlers) and the **execution plane** (isolated BullMQ worker processes).

```
                            GitHub App Webhook
                                    │ (HMAC-SHA256)
                                    ▼
                    ┌───────────────────────────────┐
                    │     Next.js API Gateway       │
                    │  (Next.js 16 / React 19)      │
                    └───────────────┬───────────────┘
                                    │
           ┌────────────────────────┴────────────────────────┐
           ▼                                                 ▼
┌─────────────────────────────┐                   ┌─────────────────────────────┐
│  PostgreSQL (Prisma 7)      │                   │   Redis 7 (BullMQ 6)        │
│  - Multi-tenant data model  │                   │   - Sliding-window rate limit   │
│  - Transactional Outbox     │                   │   - Review, visual & synth jobs │
│  - Immutable baselines      │                   │   - Retention distributed locks │
└─────────────────────────────┘                   └──────────────┬──────────────┘
                                                                 │
         ┌───────────────────────────────────────────────────────┼───────────────────────────────────────────────────────┐
         ▼                                                       ▼                                                       ▼
┌─────────────────────────────┐                         ┌─────────────────────────────┐                         ┌─────────────────────────────┐
│       Review Worker         │                         │        Visual Worker        │                         │      Synthetic Worker       │
│  - AST & Regex rules        │                         │  - Playwright Chromium      │                         │  - Journey step replay      │
│  - Secret entropy scan      │                         │  - Pixelmatch image diff    │                         │  - Latency percentiles      │
│  - Production P95 signals   │                         │  - DOM structure diff       │                         │  - Auto-resolving alerts    │
│  - GitHub check run & PR    │                         │  - Versioned baselines      │                         │  - SLA & uptime history     │
└──────────────┬──────────────┘                         └──────────────┬──────────────┘                         └──────────────┬──────────────┘
               │                                                       │                                                       │
               └───────────────────────────────────────────────────────┼───────────────────────────────────────────────────────┘
                                                                       ▼
                                                    ┌─────────────────────────────────────┐
                                                    │ Artifact Storage (S3 / Local FS)    │
                                                    │ Signed, expiring tenant tokens      │
                                                    └──────────────────┬──────────────────┘
                                                                       ▼
                                                    ┌─────────────────────────────────────┐
                                                    │ SentinelPR Executive Dashboard      │
                                                    │ Dark, keyboard-driven (⌘K), dense   │
                                                    └─────────────────────────────────────┘
```

### Core Invariants

- **Zero Untrusted Code Execution**: The API and workers never execute repository code directly. Pull requests are evaluated strictly through diff inspection, AST parsing, and safe GitHub API operations.
- **Fast-Ack Webhook Contract**: Webhook handlers validate signatures and record intent within a transactional database outbox in under 50ms, returning `202 Accepted` immediately. Heavy analysis is always processed asynchronously.
- **Authoritative Database Idempotency**: Pull request review runs enforce an explicit database unique key (`pullRequestId:headSha`). Simultaneous webhook deliveries or manual triggers never enqueue redundant work.
- **Fail-Closed Security Posture**: Production instances reject unauthenticated development modes. Missing OAuth credentials prevent server startup, accounts bind to immutable numeric provider IDs, and SSRF filters reject private and loopback IP ranges.
- **Honest Telemetry**: The platform never fabricates sample data or empty charts. When services or configurations are absent, the dashboard clearly displays structured diagnostics.

---

## Key Features

### 1. Automated PR Review & Multi-Signal Risk Engine
- **Deterministic Rule Engine**: High-speed evaluation of common security and quality flaws without LLM latency: hardcoded AWS/GitHub/Slack/Google secrets, JWT keys, `eval()`, shell injection, unescaped `dangerouslySetInnerHTML`, committed `.env` files, dangerous lifecycle scripts, empty `catch` blocks, stray `debugger`/`console.log`, and forbidden imports.
- **Explainable Risk Scoring**: Folds code diff size, AST finding severities, visual drift, and stored production P95 latency percentiles into a composite risk grade (`none`, `low`, `medium`, `high`, `critical`) with full mathematical provenance.
- **GitHub Integration**: Publishes formal GitHub Check Runs with expandable category summaries and posts deduped inline comments highlighting exact code lines.
- **Optional AI Enhancement**: Pluggable support for OpenAI-compatible endpoints with strict JSON schema validation (`zod`), confidence score gating, and a diff-boundary guard to prevent hallucinations outside modified files.

### 2. Versioned Visual Regression Testing
- **Headless Chromium Execution**: Captures deterministic snapshots with disabled CSS animations, reduced-motion media emulation, and configurable device viewports.
- **Pixel-Level Precision**: `pixelmatch` image comparison with configurable color thresholds, changed-region bounding box clustering, and visual side-by-side/overlay diff viewers.
- **DOM Structure Signatures**: Semantic inspection diffing critical UI elements (headings, buttons, inputs) to catch regressions that pixel diffs may miss due to dynamic styling.
- **Immutable Version History**: Approving a snapshot writes a new version (`version: (previous + 1)`) under a `Serializable` database lock. Older baselines remain accessible for audit provenance and are never silently overwritten.

### 3. Synthetic Journey Monitoring
- **Declarative Step Engine**: Define multi-step user flows using a validated step vocabulary: `navigate`, `click`, `fill`, `press`, `select`, `wait`, `assert_text`, `assert_visible`, `assert_url`, `screenshot`, and `request` (HTTP API probe).
- **Latency Distribution Tracking**: Measures execution durations per run to compute true rolling P50, P95, and P99 percentiles across configurable lookback windows.
- **Intelligent Alerting**: Triggers alerts on SLA threshold breaches or consecutive failure counts. Features automatic alert resolution once healthy telemetry resumes.

### 4. Enterprise Security & Multi-Tenant Access
- **Multi-User GitHub OAuth**: Server-side session management with HttpOnly/SameSite cookies, SHA-256 session token hashing at rest, and HMAC-signed expiring state cookies.
- **Immutable Provider Binding**: Users bind permanently to GitHub's numeric user ID (`githubId`), preventing account hijacking if an email is transferred or re-registered.
- **Role-Based Access Control (RBAC)**: Fine-grained `owner`, `admin`, and `member` roles. Every mutating API route enforces role boundaries and records structured audit logs.
- **Serialized Owner Invariant**: PostgreSQL row locks prevent concurrent demotion or deletion of an organization's final owner.

### 5. Production Reliability & Operational Hardening
- **Sliding-Window Rate Limiting**: Redis-backed sliding-window rate limiters with atomic Lua scripts, supporting per-IP anonymous throttling and authenticated per-user quotas.
- **Automated Data Retention**: Configurable background retention scheduler serialized across worker replicas via Redis leases. Prunes expired sessions, aged runs, and stale outbox rows.
- **Crash-Proof Artifact Deletion**: Database metadata deletions and storage deletion intents share an atomic transaction, using an `ArtifactDeletion` retry queue with exponential backoff to guarantee zero orphaned blobs.

---

## Tech Stack

| Domain | Technology | Description |
| :--- | :--- | :--- |
| **Framework** | [Next.js 16](https://nextjs.org/) (App Router) | High-performance React server components & API route handlers |
| **UI & Styling** | [React 19](https://react.dev/), [Tailwind CSS 4](https://tailwindcss.com/) | Dark zinc/indigo design system, keyboard-accessible command palette |
| **Language** | [TypeScript 5](https://www.typescriptlang.org/) | Strict mode enabled across all web routes, workers, and test suites |
| **Database** | [PostgreSQL 17](https://www.postgresql.org/) via [Prisma 7](https://www.prisma.io/) | Multi-tenant schema with driver adapters, serializable transactions |
| **Queues** | [BullMQ 6](https://bullmq.io/) + [IORedis](https://github.com/redis/ioredis) | Distributed job pipelines with retry backoff and scheduled workers |
| **Automation** | [Playwright](https://playwright.dev/) | Headless browser execution for visual regressions and E2E journeys |
| **Storage** | [@aws-sdk/client-s3](https://aws.amazon.com/sdk-for-javascript/) | Compatible with AWS S3, Cloudflare R2, MinIO, or local disk driver |
| **Testing** | [Vitest 5](https://vitest.dev/), [Playwright Test](https://playwright.dev/) | Isolated integration testing, unit mocks, and browser E2E specs |

---

## Quickstart (Local Development)

### Prerequisites
- Node.js 20+
- `pnpm` (10+)
- Docker & Docker Compose (for PostgreSQL, Redis, and MinIO)

### 1. Clone & Install Dependencies
```bash
git clone https://github.com/your-org/sentinelpr.git
cd sentinelpr
pnpm install
```

### 2. Configure Environment
```bash
cp .env.example .env
```
*The default `.env` is pre-configured for local Docker development. High-value credentials (such as GitHub App secrets) can be added as needed.*

### 3. Start Infrastructure & Run Migrations
```bash
# Launch PostgreSQL 17, Redis 7, and MinIO
docker compose up -d

# Apply database migrations
pnpm db:migrate
```

### 4. Start the Application & Workers
Start the web dashboard:
```bash
pnpm dev
# Dashboard accessible at http://localhost:3000
```

In separate terminal tabs, start the background worker services:
```bash
pnpm worker:review     # PR review queue & outbox reconciler
pnpm worker:visual     # Visual regression Playwright worker
pnpm worker:synthetic  # 24/7 synthetic monitoring worker
```

---

## 60-Second Offline Smoke Test

You can test visual regression and synthetic monitoring locally without any GitHub credentials:

1. **Synthetic Monitoring**:
   - Open `http://localhost:3000/synthetic` → click **New Monitor**.
   - Target URL: `https://example.com`, interval: `*/5 * * * *`.
   - Steps:
     ```json
     [
       { "type": "navigate", "url": "/" },
       { "type": "assert_text", "selector": "h1", "text": "Example Domain" },
       { "type": "screenshot" }
     ]
     ```
   - Click **Run Now** and observe the live step results, screenshots, and latency waterfall.
2. **Visual Regression**:
   - Open `http://localhost:3000/visual` → click **New Suite**.
   - Create a test pointing to any URL → click **Run**.
   - Click **Approve as Baseline** to record version 1.
   - Run the test again to verify `0.00%` pixel drift against the immutable baseline.

---

## Testing & Verification Tiers

SentinelPR adheres to a deterministic, multi-tier testing strategy ensuring enterprise stability across database invariants, concurrency races, and browser interactions.

```bash
# 1. Static Typecheck
pnpm typecheck

# 2. Fast Unit Suite (220 tests across 30 test files)
pnpm test

# 3. Isolated PostgreSQL & Redis Integration Suite
# Exercises owner concurrency, production P95 signals, rate limits, and retention
powershell scripts/run-isolated-integrations.ps1
# (or in CI: RUN_DB_INTEGRATION=1 pnpm test:integration)

# 4. Playwright Browser End-to-End Suite
# Exercises OAuth redirection, session security, and HMAC webhook ingestion
powershell scripts/run-e2e.ps1
# (or: pnpm test:e2e)
```

### Verification Matrix

| Suite | Scope | Target Services |
| :--- | :--- | :--- |
| **Unit (`pnpm test`)** | AST rules, SSRF IP parser, HMAC validator, risk math, finding deduplication | In-memory mocks |
| **Integration (`pnpm test:integration`)** | Owner race conditions, P95 aggregation, Redis sliding window, retention outbox | Real PostgreSQL 17 & Redis 7 |
| **Browser E2E (`pnpm test:e2e`)** | Protected route redirection, OAuth state verification, HMAC webhook to PR render | Isolated `.next-e2e` web server & Chromium |
| **Static Verification (`pnpm typecheck`)** | Full codebase strict TypeScript coverage | Next.js App Router & Worker processes |

---

## Repository Scripts Reference

| Command | Action |
| :--- | :--- |
| `pnpm dev` | Starts Next.js development server on `http://localhost:3000` |
| `pnpm build` | Compiles production Next.js application bundle |
| `pnpm start` | Launches compiled production server |
| `pnpm worker:review` | Runs review queue worker, outbox reconciler, and retention scheduler |
| `pnpm worker:visual` | Runs Playwright visual capture and pixel comparison worker |
| `pnpm worker:synthetic` | Runs scheduled synthetic journey monitor worker |
| `pnpm db:migrate` | Applies pending Prisma migrations to the active database |
| `pnpm db:generate` | Regenerates Prisma TypeScript client |
| `pnpm test` | Runs offline Vitest test suites |
| `pnpm test:integration` | Runs PostgreSQL/Redis database integration specs |
| `pnpm test:e2e` | Runs Playwright browser E2E test suite |
| `pnpm test:e2e:install` | Downloads Playwright Chromium browser binaries |
| `pnpm screenshots` | Captures updated dashboard screenshots into `docs/images/` |

---

## Deep-Dive Documentation

- 📖 [Deployment & Production Topology](docs/deployment.md) — Production multi-container topology, fail-closed checklists, and reverse proxy guidelines.
- 🔐 [Comprehensive Security Model](docs/security-model.md) — Threat models, credential sanitization, SSRF filters, and tenant isolation policies.
- 🐙 [GitHub App Setup Walkthrough](docs/github-app-setup.md) — Step-by-step GitHub App registration, private key encoding, and webhook setup.
- 🖼️ [Visual Baselines & Comparison](docs/visual-baselines.md) — Versioning lifecycle, pixelmatch thresholds, and DOM structure verification.
- ⏱️ [Synthetic Monitoring & Alerting](docs/synthetic-monitoring.md) — Journey step schemas, cron scheduling, and webhook alert fan-out.
- ⚙️ [Configuration Reference](docs/configuration.md) — Comprehensive environment variable dictionary with validation rules.
- 🧪 [Browser E2E Testing Guide](docs/e2e-testing.md) — Isolation requirements, seed fixtures, and local test runners.
- 🧹 [Retention Policy & Operations](docs/retention.md) — Safe pruning procedures, distributed Redis leases, and outbox blob cleanup.

---

## Contributing & Security

- **Contributing**: Contributions are welcome! Please review [CONTRIBUTING.md](CONTRIBUTING.md) for workflow guidelines and coding standards.
- **Security Vulnerabilities**: We take software security seriously. Please report potential vulnerabilities privately following [SECURITY.md](SECURITY.md) instead of opening public issues.

---

## License

This project is licensed under the [MIT License](LICENSE).
