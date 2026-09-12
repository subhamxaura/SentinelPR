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

## Authentication & sessions (OAuth mode)

Two deployment modes exist, resolved by `src/lib/auth/mode.ts`:

- **local** — legacy single trusted operator. `SENTINEL_ORG_SLUG` is bootstrapped on first use and
  every request acts on it. Suitable for localhost development only.
- **oauth** — GitHub OAuth sign-in with database-backed sessions. Selected explicitly with
  `SENTINEL_AUTH_MODE=oauth` or auto-selected when `AUTH_GITHUB_CLIENT_ID`/`SECRET` are set.

OAuth mode guarantees:

- The browser holds only an opaque 256-bit token in an **HttpOnly, SameSite=Lax** cookie (Secure in
  production). The database stores only its SHA-256 digest; a stolen database backup cannot be
  replayed into sessions.
- OAuth `state` is HMAC-signed and expiring (10 minutes) with the same construction as artifact
  tokens, binding the callback to a browser-initiated flow (CSRF defense). Post-sign-in redirects
  are restricted to same-origin relative paths.
- Sessions live in the `Session` table with a 7-day sliding expiry, hashed IP metadata, and
  user-agent capture. Sign-out deletes the row and the cookie.
- GitHub identity is matched by **primary verified email** (via `/user/emails`), with the unique
  GitHub login as a secondary key if the email changes on GitHub's side.

## Authorization (RBAC)

- Every page and API route resolves the acting organization server-side (`requireOrganization` /
  `requirePageOrganization`) and scopes every query by `organizationId`. Client-supplied
  org/repository/test IDs are always re-validated against that scope before use — a forged ID for
  another org is a 404, not a leak.
- **Roles:** `owner` > `admin` > `member` on `OrganizationMember`. Members may read everything in
  their org but cannot mutate configuration (create/update/delete suites, monitors, repositories,
  baselines, or trigger runs). The check is centralized in `requireMutationRole` and enforced by
  every API route. In local mode the check is a no-op (single trusted operator).
- **Access provisioning:** users get memberships from pre-created rows, pending
  `OrganizationInvite` rows (consumed at sign-in), or — unless `AUTH_ALLOW_DEFAULT_ORG_SIGNUP=0` —
  auto-join the default organization (first user becomes owner). With auto-join disabled and no
  invite, sign-in lands on an access-pending screen and exposes no data. From there users can
  **request access** (`POST /api/access-requests`, authenticated by session only): admins see the
  request on `/team` and approve (membership granted transactionally) or deny it. Requesters and
  denied users see their status on the sign-in screen; no dashboard data is exposed to them.
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

The schema has been multi-tenant from day one (organizations, members, every domain row scoped by
org). **OAuth mode completes the deployment story:** users authenticate with GitHub, sessions are
stored server-side, and every query is scoped by membership.

GitHub App installations arrive via webhook **unclaimed** — an organization identity cannot be
derived from a webhook payload. An admin claims the installation from the Repositories page
(`POST /api/installations/:id/claim`, admin/owner only), which binds it to exactly one
organization and backfills its repositories. Until claimed, those repositories remain inactive and
PR events are skipped rather than leaking into a default tenant.

Residual boundaries to know about:

- In **local** mode there is no authentication at all — keep localhost-only, or put your own auth
  (reverse-proxy SSO, mTLS) in front.
- Roles are organization-global; per-resource ACLs (e.g. a member limited to one suite) are not
  implemented.
- Team management lives on the `/team` page (admin/owner only). **Invites:** admins may invite
  `member` and `admin`; only owners may assign `owner`; invites are consumed at sign-in **and**
  lazily on any subsequent authenticated request. **Role editing** (`PATCH /api/members/:id`) and
  **removal** (`DELETE`) enforce owner protection: owners are immutable to everyone — to hand over
  ownership, promote a member to owner and self-demote; the last owner can never be demoted or
  removed, even by themselves. Members may self-demote (give up admin). Every change is
  audit-logged with the actor, before and after roles.

## Prompt-injection stance

PR descriptions, repo content and AI outputs are treated as data, never as instructions. The AI
review prompt states this explicitly; AI findings are zod-validated, restricted to files that
actually appear in the diff, confidence-gated, and can never call GitHub APIs directly — only the
pipeline publishes, through thresholds and dedupe.
