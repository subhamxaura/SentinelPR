# Deployment guide

SentinelPR ships as a single container image that runs the dashboard, any of the three workers, or
one-shot migrations — selected by the container command. The stack: PostgreSQL, Redis, object
storage (S3/MinIO/R2), and the image itself.

## 1. Get the image

**Prebuilt (recommended):** every version tag publishes to GHCR via the release workflow:

```bash
docker pull ghcr.io/<owner>/sentinelpr:latest   # or a pinned version, e.g. :1.2.3
```

**Build locally:**

```bash
docker build -t sentinelpr .
```

The image bakes in the production dashboard bundle, the Prisma client, and Chromium with system
libraries, so the visual and synthetic workers are ready on first boot.

## 2. Full local stack (docker compose)

```bash
docker compose --profile app up -d
```

This starts Postgres, Redis, MinIO, applies migrations, then launches the dashboard
(`http://localhost:3000`) and all three workers. Bare `docker compose up -d` still starts only the
infrastructure. GitHub/App/AI credentials are read from `.env` when present (`env_file` is
optional).

## 3. Production topology

| Component | Recommendation |
| --- | --- |
| Dashboard | 2+ replicas behind a load balancer (stateless — sessions live in Postgres) |
| Review worker | 1–2 replicas |
| Visual worker | 1+ replicas (Playwright is memory-hungry; ~1 GB per concurrent run) |
| Synthetic worker | 1 replica is usually enough; schedulers deduplicate ticks |
| PostgreSQL | Managed (RDS/Cloud SQL/Neon). Take the `DATABASE_URL` from its console |
| Redis | Managed or ElastiCache/Upstash. TLS URL works out of the box |
| Artifacts | S3/Cloudflare R2 (`ARTIFACT_DRIVER=s3`), or a persisted volume for local FS |

## 4. Environment & secrets

Copy `.env.example` and fill in what your deployment needs. Items to treat carefully in production:

- `AUTH_STATE_SECRET` and `ARTIFACT_TOKEN_SECRET` — generate with
  `openssl rand -base64 32`. If `ARTIFACT_TOKEN_SECRET` is unset it falls back to a value derived
  from `DATABASE_URL`, which is fine locally but should be explicit in production.
- Session cookies switch to `Secure` automatically when `NODE_ENV=production` — serve the dashboard
  behind HTTPS.
- `DASHBOARD_URL` must be the public URL: the OAuth callback is
  `{DASHBOARD_URL}/api/auth/github/callback` and webhook deliveries arrive at
  `{DASHBOARD_URL}/api/github/webhook`.

## 5. GitHub wiring

Two independent integrations:

1. **OAuth App** (user sign-in) — create at <https://github.com/settings/developers>, callback
   `{DASHBOARD_URL}/api/auth/github/callback`, then set `AUTH_GITHUB_CLIENT_ID` and
   `AUTH_GITHUB_CLIENT_SECRET`. See [configuration.md](configuration.md) for the auth variables and
   access-provisioning behavior.
2. **GitHub App** (repository reviews) — create at <https://github.com/settings/apps/new> with the
   webhook URL above; see [github-app-setup.md](github-app-setup.md) for permissions and key
   encoding.

## Releasing a new version

Releases are tag-driven:

```bash
git tag v0.2.0 && git push origin v0.2.0
```

The release workflow re-verifies the tagged commit (typecheck + unit tests), builds the image with
GHA layer caching, pushes it to GHCR tagged with the full semver, the major.minor, the major, and
`latest`, and publishes a GitHub release with generated notes. CI runs the same image build on
every push, so a release tag never triggers a first-time build.

## 6. Migrations

Migrations are plain SQL files under `prisma/migrations` and run with:

```bash
docker run --rm -e DATABASE_URL=... sentinelpr pnpm db:migrate
```

The compose `migrate` service does this automatically before the app starts. Deployments should run
migrations once per release (a job step, an ECS one-shot task, or the compose service above).

## 7. Health checks & operations

- The Settings page probes every subsystem live (database, Redis, storage, GitHub, auth) — the
  fastest way to diagnose a fresh deployment.
- `GET /api/session` returns the auth mode and session state; a 200 means the dashboard and
  database are reachable.
- Structured JSON logs (with secret redaction) are emitted on stdout by the dashboard and all
  workers — ship them to your log pipeline as-is.
- **Metrics:** every worker serves Prometheus text exposition at
  `http://<worker-host>:9464/metrics` (override with `METRICS_PORT`). Series:
  `sentinelpr_queue_jobs_total{queue,outcome}`, `sentinelpr_queue_active_jobs{queue}`,
  `sentinelpr_queue_depth{queue,state}` (sampled live from Redis on each scrape),
  `sentinelpr_queue_job_duration_seconds` (histogram, wall-clock `processedOn`→done), and
  `sentinelpr_worker_up{worker}`. The naming maps 1:1 onto OpenTelemetry semantic conventions, so
  an OTel Collector's Prometheus receiver produces OTLP-native series for Grafana/dashboards. In
  docker compose the ports are exposed but not published to the host; add `ports: ["9464:9464"]`
  per worker service (or run an OTel Collector on the same network) to scrape them externally.
  Metrics are failure-isolated: Redis or port errors never affect job processing.

## 8. Hardening checklist

- [ ] HTTPS everywhere; cookies are `Secure` in production automatically.
- [ ] Strong `AUTH_STATE_SECRET` + `ARTIFACT_TOKEN_SECRET`.
- [ ] `SENTINEL_ALLOW_PRIVATE_TARGETS` stays `0` (default) — workers should not reach internal
      networks; run them in an isolated network segment.
- [ ] Restrict database/Redis ingress to the app/workers.
- [ ] Restrict `METRICS_PORT` exposure — the scrape endpoint is unauthenticated, network-level
  metadata only (no secrets in labels), so keep it on the internal worker network.
- [ ] Rotate the GitHub App private key and webhook secret periodically.
- [ ] Back up Postgres (it holds sessions, baselines metadata, alerts, audit log).
