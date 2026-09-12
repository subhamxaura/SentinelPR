# Security model

Security is a first-class feature of SentinelPR. This document states the actual guarantees and the
honest limitations of the current implementation.

## Trust boundaries

```
Untrusted                          Trusted
─────────                          ───────
PR content (diffs, titles,         API process      PostgreSQL
descriptions, repo files)   ──►    Workers          Redis
Dashboard users' inputs          Dashboard        Object storage
GitHub webhook payloads
```

**Repository code is never executed.** The review engine reads diffs through the GitHub API and
runs pure analysis. Playwright workers navigate configured URLs; they do not build or run PR code.
(The schema reserves build/start command fields for a sandboxed future; wiring them to the host
without a container boundary is deliberately NOT implemented — see Limitations.)

## Webhooks

- `X-Hub-Signature-256` validated with HMAC-SHA256 in constant time against the raw request body;
  failures are rejected 401 before parsing.
- Deliveries are deduplicated by the `X-GitHub-Delivery` id (unique index) — redeliveries are
  acknowledged without side effects.
- The endpoint validates and records, then enqueues and responds 202 — no analysis on the request
  path. Malformed payloads are rejected 400; processing errors are recorded per delivery for
  debugging, and GitHub's retry policy covers transient failures.

## Secrets handling

- GitHub App private key, webhook secret, PAT, DB/Redis credentials and AI keys are read from
  environment only, in server-only modules (`src/lib/env.ts`, `src/lib/github/*`).
- The structured logger redacts secret-named keys and token-shaped values (ghp_/AKIA/xox/JWT
  patterns) before writing a line.
- No secret ever crosses into a client component; API routes return structured errors, never stack
  traces.

## Authorization

- Every page and API route resolves the acting organization server-side (`resolveOrganization`)
  and scopes every query by `organizationId`. Client-supplied org/repository/test IDs are always
  re-validated against that scope before use — a forged ID for another org is a 404, not a leak.
- Artifact bytes (screenshots, diffs, baselines) are never publicly readable: pages mint
  short-lived HMAC-signed URLs; `/api/artifacts/:id` verifies the token binds to the artifact id
  and expiry.

## SSRF guard (visual suites & synthetic monitors)

Users configure arbitrary URLs, which workers then fetch/navigate — that is an SSRF surface, and it
is guarded in `src/lib/net/guard.ts`:

1. Scheme allowlist: http/https only.
2. Hostname blocklist: `localhost`, `*.local`, `*.internal`, `host.docker.internal`, cloud metadata
   hostnames.
3. DNS resolution + IP blocklist: loopback, RFC1918, CGNAT, link-local (169.254/16 — includes
   cloud metadata endpoints), benchmark and reserved ranges, IPv6 loopback/ULA/link-local and
   IPv4-mapped addresses.
4. `SENTINEL_ALLOW_PRIVATE_TARGETS=1` relaxes this **for local development only** (documented in
   `.env.example`).

**Known limitation — DNS rebinding:** the guard validates at URL-configuration/request time; the
subsequent fetch resolves DNS again, so an attacker controlling DNS could rebind between check and
fetch. The complete fix is a pinned-connection HTTP client and browser proxy. Documented as a
v1 boundary; production deployments should place workers in a network-isolated environment.

## Workers

- Separate OS processes (`src/workers/*`) with per-queue concurrency limits, 10-minute job locks,
  stalled-job detection, retries with exponential backoff, and graceful shutdown.
- Playwright contexts use fixed locale/timezone/reduced-motion; runs have per-step and per-run
  timeouts. Browser processes are closed on all paths.
- Separate artifact keys per organization keep storage logically partitioned.

## Multi-tenancy status (honest)

The schema is multi-tenant (organizations, members, every domain row scoped by org). The
deployment currently runs in **local single-tenant mode**: `resolveOrganization()` bootstraps one
default organization per environment. There is no OAuth session provider yet; replacing that one
function with a session-backed lookup is the designed upgrade path. Until then, do not expose a
deployment publicly without putting your own auth (reverse-proxy SSO, mTLS, etc.) in front of it.

## Prompt-injection stance

PR descriptions, repo content and AI outputs are treated as data, never as instructions. The AI
review prompt states this explicitly; AI findings are zod-validated, restricted to files that
actually appear in the diff, confidence-gated, and can never call GitHub APIs directly — only the
pipeline publishes, through thresholds and dedupe.
