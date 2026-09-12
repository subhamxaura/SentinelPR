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
| `SENTINEL_AUTH_MODE` | auto | `oauth` enables GitHub sign-in; `local` pins the legacy single-operator mode. Auto = oauth when client credentials exist. |
| `AUTH_GITHUB_CLIENT_ID` | — | GitHub OAuth App client id. |
| `AUTH_GITHUB_CLIENT_SECRET` | — | GitHub OAuth App client secret. |
| `AUTH_STATE_SECRET` | derived fallback | HMAC secret for signed OAuth state + session binding. Set a strong random value in production. |
| `AUTH_ALLOW_DEFAULT_ORG_SIGNUP` | `1` | `0` disables auto-joining the default org — access then requires an explicit invite or an admin-approved request from the sign-in screen. |

Setup: create a GitHub **OAuth App** (not an App Installation) at <https://github.com/settings/developers>
with the callback URL `{DASHBOARD_URL}/api/auth/github/callback`, then set the client id/secret.
The first signed-in user becomes owner of the default organization; further users auto-join as
`member` (or need invites when `AUTH_ALLOW_DEFAULT_ORG_SIGNUP=0`).

## GitHub

| Variable | Description |
| --- | --- |
| `GITHUB_APP_ID` | App ID from the GitHub App settings page. |
| `GITHUB_APP_SLUG` | Slug (used to render install links). |
| `GITHUB_APP_PRIVATE_KEY` | PEM, raw (with `\n`) or base64-encoded. |
| `GITHUB_WEBHOOK_SECRET` | Validates `X-Hub-Signature-256`. Webhooks are disabled (503) without it. |
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
