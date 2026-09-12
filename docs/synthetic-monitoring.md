# Synthetic monitoring & scheduling

Synthetic monitors replay critical user journeys (login, search, checkout, API health) on a
schedule and convert failures into alerts with real latency percentiles and availability history.

## Steps

Steps are JSON, validated with zod on create/update and re-validated at execution:

| Step | Fields | Notes |
| --- | --- | --- |
| `navigate` | `url` | resolved against the test base URL |
| `click` | `selector` | Playwright selector |
| `fill` | `selector`, `value` | |
| `press` | `key`, `selector?` | optionally clicks first |
| `select` | `selector`, `value` | |
| `wait` | `ms?` / `selector?` | |
| `assert_text` | `selector`, `text`, `contains?` | exact match when `contains:false` |
| `assert_visible` | `selector` | |
| `assert_url` | `url` | prefix match after resolution |
| `screenshot` | `name?` | artifact stored on success and on failure paths |
| `request` | `method`, `url`, `headers?`, `body?`, `expectStatus?` | API health checks |

First failing step stops the journey; later steps are recorded as `skipped`. Every failure
captures a screenshot at the moment of failure. Per-step timeout 20s, whole-run 180s.

Example — login journey:

```json
[
  { "type": "navigate", "url": "/login" },
  { "type": "fill", "selector": "input[name=email]", "value": "monitor@example.com" },
  { "type": "fill", "selector": "input[name=password]", "value": "…" },
  { "type": "click", "selector": "button[type=submit]" },
  { "type": "assert_url", "url": "/dashboard" },
  { "type": "assert_visible", "selector": "[data-testid=user-menu]" },
  { "type": "screenshot", "name": "dashboard-loaded" }
]
```

Monitors are separate operator credentials — use a dedicated account, never real user secrets.

## Scheduling (BullMQ job schedulers)

- One **updatable job scheduler** per test (`upsertJobScheduler`, BullMQ v6 API — the deprecated
  `repeat` API is not used).
- `paused` state removes the scheduler; resume re-upserts it.
- The database is the source of truth: the synthetic worker reconciles all schedules with Redis at
  startup (upsert wanted, remove stale), so drift and lost Redis state self-heal.
- Duplicate-tick prevention: a scheduled tick is skipped if the test already has a queued/running
  run.
- Retries (3, exponential backoff from 10s) apply to *infrastructure* failures in the queue layer;
  a journey that reaches its assertions and fails them is a `failed` run, not a retryable job —
  that distinction keeps metrics honest.

## Metrics & alerts

From the run history (newest first):

- availability = passed / total over the lookback window
- P50 / P95 / P99 / average over *successful* run durations (failures are failures, not latency
  samples — mixing them hides outages)
- consecutive failures (streak from the newest run)

Alerts (in-app always; outgoing webhook when `ALERT_WEBHOOK_URL` is set):

| Alert | Condition | Dedup |
| --- | --- | --- |
| `synthetic_failure` | a run failed | one open alert per test, re-raised updates it |
| `consecutive_failures` | streak ≥ `maxConsecutiveFailures` (default 3) | per test |
| `latency_threshold` | P95 > `alertLatencyMs` | per test |

All three **auto-resolve** when the next run passes, so alert state mirrors production health.
Manual runs (`Run now`) use the same pipeline and metrics.

## Targeting rules

Targets pass the SSRF guard (see docs/security-model.md): public http/https URLs only, unless
`SENTINEL_ALLOW_PRIVATE_TARGETS=1` for local development.
