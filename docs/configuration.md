# Configuration reference

All configuration is environment-based (`.env`, see `.env.example`). The Settings page shows the
live configuration state of every subsystem.

## Core

| Variable | Default | Description |
| --- | --- | --- |
| `DATABASE_URL` | — | PostgreSQL. Required; without it the app fails fast with a configuration error. |
| `REDIS_URL` | — | Redis for BullMQ. Required for queues/workers/manual runs; the UI probes it live. |
| `DASHBOARD_URL` | `http://localhost:3000` | Public URL, used in GitHub check-run links and webhook docs. |
| `LOG_LEVEL` | `debug` (dev) / `info` (prod) | Structured JSON logging. |
| `SERVICE_NAME` | `sentinelpr` | Log service field. |

## Local mode

| Variable | Default | Description |
| --- | --- | --- |
| `SENTINEL_ORG_SLUG` | `default` | Organization resolved server-side for every request. |
| `SENTINEL_ORG_NAME` | `Default Organization` | Display name. |

## Authentication (multi-user OAuth)

| Variable | Default | Description |
| --- | --- | --- |
| `SENTINEL_AUTH_MODE` | auto | `oauth` enables GitHub sign-in; `local` pins the legacy single-operator mode in development only. Auto selects OAuth when credentials exist; production rejects local mode and fails closed if credentials are missing. |
| `AUTH_GITHUB_CLIENT_ID` | — | GitHub OAuth App client id. |
| `AUTH_GITHUB_CLIENT_SECRET` | — | GitHub OAuth App client secret. |
| `AUTH_STATE_SECRET` | derived fallback | HMAC secret for signed OAuth state + session binding (`AUTH_SECRET` also supported). Required in production. |
| `AUTH_ALLOW_DEFAULT_ORG_SIGNUP` | `1` | `0` disables auto-joining the default org — access then requires an explicit invite or an admin-approved request from the sign-in screen. |

Setup: create a GitHub **OAuth App** (not an App Installation) at <https://github.com/settings/developers>
with the callback URL `{DASHBOARD_URL}/api/auth/github/callback`, then set the client id/secret.
The first signed-in user becomes owner of the default organization; further users auto-join as
`member` (or need invites when `AUTH_ALLOW_DEFAULT_ORG_SIGNUP=0`). User rows bind to GitHub's
immutable numeric account ID; a conflicting verified email is rejected rather than merged.

## GitHub

| Variable | Description |
| --- | --- |
| `GITHUB_APP_ID` | App ID from the GitHub App settings page. |
| `GITHUB_APP_SLUG` | Slug (used to render install links). |
| `GITHUB_APP_PRIVATE_KEY` | PEM, raw (with `\n`) or base64-encoded. |
| `GITHUB_WEBHOOK_SECRET` | Validates `X-Hub-Signature-256`. Webhooks are disabled (503) without it. |
| `GITHUB_INSTALLATION_SECRET` | Dedicated HMAC secret for installation flow (`GITHUB_APP_SETUP_SECRET` also supported; falls back to domain-separated `AUTH_STATE_SECRET`). Production fails closed if neither is configured. |
| `GITHUB_TOKEN` | PAT fallback for manual review runs on repos not connected via the App. |

## AI review (optional — pipeline is fully functional without it)

| Variable | Default | Description |
| --- | --- | --- |
| `AI_PROVIDER` | — | Set to `openai-compatible` to enable. |
| `AI_API_KEY` | — | Provider API key. |
| `AI_BASE_URL` | `https://api.openai.com/v1` | Any OpenAI-compatible endpoint (vLLM, Ollama, OpenRouter…). |
| `AI_MODEL` | `gpt-4o-mini` | Model id. |
| `AI_CONFIDENCE_THRESHOLD` | `0.6` | Findings below this confidence are dropped, not published. |

## Artifact storage

| Variable | Default | Description |
| --- | --- | --- |
| `ARTIFACT_DRIVER` | `local` | `local` (filesystem) or `s3` (S3/MinIO/R2). |
| `ARTIFACT_LOCAL_DIR` | `.data/artifacts` | Local driver directory (git-ignored). |
| `S3_ENDPOINT` | — | Set for MinIO/R2; unset for AWS S3. |
| `S3_REGION` / `S3_BUCKET` / `S3_ACCESS_KEY_ID` / `S3_SECRET_ACCESS_KEY` | — | S3 credentials. |
| `ARTIFACT_TOKEN_SECRET` | derived | HMAC key for signed artifact URLs. Set a strong random value in production. |

## API rate limits

Limits are enforced per authenticated user (anonymous requests use an unattributed bucket unless trusted proxy hops are configured) and shared across app replicas through Redis in production. All count/window settings must be positive integers; invalid values fail configuration loading. Defaults are shown below.

| Variable | Default | Description |
| --- | --- | --- |
| `RATE_LIMIT_SECRET` | `AUTH_STATE_SECRET` fallback | HMAC key for opaque Redis keys. Required in production if `AUTH_STATE_SECRET`/`AUTH_SECRET` is absent. |
| `RATE_LIMIT_TRUSTED_PROXY_HOPS` | `0` | Number of rightmost `X-Forwarded-For` hops controlled by trusted proxies. Keep `0` unless the proxy chain is known and strips/rebuilds forwarding headers. |
| `RATE_LIMIT_WINDOW_SECONDS` | `60` | Window for regular API limits. |
| `RATE_LIMIT_READ_PER_MINUTE` | `120` | Per-user authenticated request limit; this also applies to mutations. |
| `RATE_LIMIT_WRITE_PER_MINUTE` | `60` | Additional per-user limit for mutating methods. |
| `RATE_LIMIT_ANONYMOUS_PER_MINUTE` | `60` | Unauthenticated API limit per trusted client address/bucket. |
| `RATE_LIMIT_EXPENSIVE_WINDOW_SECONDS` | `600` | Shared window for OAuth and expensive actions. |
| `RATE_LIMIT_OAUTH_PER_WINDOW` | `20` | OAuth start and callback attempts, separately scoped. |
| `RATE_LIMIT_MANUAL_REVIEW_PER_WINDOW` | `5` | Manual review enqueue attempts per user. |
| `RATE_LIMIT_VISUAL_RUN_PER_WINDOW` | `5` | Visual browser-run requests per user. |
| `RATE_LIMIT_SYNTHETIC_RUN_PER_WINDOW` | `10` | Synthetic run requests per user. |
| `RATE_LIMIT_INSTALLATION_PER_WINDOW` | `10` | GitHub App installation-flow attempts per user. |
| `RATE_LIMIT_ACCESS_REQUEST_PER_WINDOW` | `3` | Self-service access requests per user. |
| `RATE_LIMIT_ARTIFACT_DOWNLOAD_PER_MINUTE` | `60` | Valid signed artifact downloads per bearer token. |

## Database and artifact retention

Retention runs only when explicitly enabled and is scheduled by the review worker. It processes one bounded page per data class, coordinates replicas with a Redis lease, and emits structured completion counts. Start with dry-run mode, review the worker logs, and enable deletion only after backups and restore procedures are tested.

| Variable | Default | Description |
| --- | --- | --- |
| `RETENTION_ENABLED` | `0` | Set to `1` to enable scheduled pruning; default is safely disabled. |
| `RETENTION_DRY_RUN` | `0` in code; `1` in `.env.example` | When `1`, report eligible counts without changing database rows or objects. |
| `RETENTION_INTERVAL_HOURS` | `24` | Scheduler interval, from 1 to 168 hours. First pass starts about one minute after the review worker starts. |
| `RETENTION_BATCH_SIZE` | `100` | Maximum rows considered per table/object pass, from 1 to 500. Remaining rows are handled by later passes. |
| `RETENTION_REVIEW_RUN_DAYS` | `180` | Age threshold for terminal review runs (`success`, `failure`, `error`); their findings cascade. |
| `RETENTION_VISUAL_RUN_DAYS` | `90` | Age threshold for terminal visual runs (`passed`, `failed`, `error`); snapshots cascade. |
| `RETENTION_SYNTHETIC_RUN_DAYS` | `90` | Age threshold for terminal synthetic runs (`passed`, `failed`, `error`); step results cascade. |
| `RETENTION_JOB_RECORD_DAYS` | `30` | Age threshold for completed/failed queue job records. |
| `RETENTION_WEBHOOK_DELIVERY_DAYS` | `90` | Age threshold for processed, skipped, or failed webhook-delivery ledger rows. |
| `RETENTION_ARTIFACT_DAYS` | `90` | Age threshold for artifacts with no baseline, snapshot, or synthetic-step references. |
| `RETENTION_REVIEW_OUTBOX_DAYS` | `30` | Age threshold for dispatched review-outbox rows. Pending/dispatching rows are never selected. |
| `RETENTION_AUDIT_LOG_DAYS` | `0` | `0` preserves audit logs indefinitely; only an explicitly positive value enables pruning. |

Expired sessions are removed on every enabled pass. Queued/running work is preserved. Any artifact referenced by any baseline (active or historical), snapshot, or synthetic step is excluded. Eligible artifact metadata and a durable object-deletion intent commit atomically; the worker retries storage deletion with backoff if the object store is unavailable. See [retention.md](retention.md) for rollout and recovery guidance.

## Security & alerting

| Variable | Default | Description |
| --- | --- | --- |
| `SENTINEL_ALLOW_PRIVATE_TARGETS` | `0` | Allow localhost/private targets for visual suites & synthetic monitors. **Local dev only.** |
| `ALERT_WEBHOOK_URL` | — | Outgoing JSON POST for alert fan-out (Slack-compatible shape). |

## Worker metrics

| Variable | Default | Description |
| --- | --- | --- |
| `METRICS_PORT` | `9464` | Per-worker Prometheus exposition port (`/metrics`): queue depth, active jobs, job totals and duration histograms. Ingest with an OTel Collector (Prometheus receiver), Prometheus, or Grafana Agent. Failure-isolated — never affects job processing. |

## Repository-level review config

Stored as JSON on each repository row (see the Repositories page):

```json
{
  "disabledRules": ["quality/console-log"],
  "severityOverrides": { "maintainability/todo-without-issue": "low" },
  "maxComments": 10,
  "confidenceThreshold": 0.6,
  "publishSeverities": ["critical", "high", "medium"],
  "forbiddenImports": ["lodash", "moment"]
}
```

- `maxComments` caps inline GitHub comments per review (0–50).
- `publishSeverities` gates which severities are commented; lower severities are still stored and
  visible in the dashboard.
- `forbiddenImports` are regex sources matched against import specifiers.
