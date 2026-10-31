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
- Deliveries are deduplicated by the `X-GitHub-Delivery` id (unique index); duplicate deliveries
  are acknowledged without side effects. A delivery that failed processing is re-claimed and
  reprocessed when GitHub redelivers the same id.
- The endpoint validates and records, then commits the review run and a dispatch-outbox row before
  responding 202 — no analysis on the request path. A worker reconciles pending/expired outbox
  leases, and deterministic queue job IDs make add-before-mark retries safe. Missing delivery ids
  and non-object payloads are rejected 400; failed deliveries can be reclaimed on redelivery.

## Secrets handling

- GitHub App private key, webhook secret, PAT, DB/Redis credentials and AI keys are read from
  environment only, in server-only modules (`src/lib/env.ts`, `src/lib/github/*`).
- The structured logger redacts secret-named keys and token-shaped values (ghp_/AKIA/xox/JWT
  patterns) before writing a line.
- No secret ever crosses into a client component; API routes return structured errors, never stack
  traces.
- Artifact URLs use a dedicated HMAC secret (`ARTIFACT_TOKEN_SECRET`, or a domain-separated
  `AUTH_STATE_SECRET` fallback). Production fails closed if neither is configured; the local
  development fallback is never used for a production sign/verify.
- OAuth `state` uses `AUTH_STATE_SECRET`; production fails closed if it is missing. The local
  development fallback is a fixed in-process constant, never derived from the database URL.

## Authentication & sessions (OAuth mode)

Two deployment modes exist, resolved by `src/lib/auth/mode.ts`:

- **local** — legacy single trusted operator. `SENTINEL_ORG_SLUG` is bootstrapped on first use and
  every request acts on it. Development only; production rejects local mode and fails closed unless
  GitHub OAuth credentials are configured.
- **oauth** — GitHub OAuth sign-in with database-backed sessions. Selected explicitly with
  `SENTINEL_AUTH_MODE=oauth` or auto-selected when `AUTH_GITHUB_CLIENT_ID`/`SECRET` are set.

OAuth mode guarantees:

- The browser holds only an opaque 256-bit token in an **HttpOnly, SameSite=Lax** cookie (Secure in
  production). The database stores only its SHA-256 digest; a stolen database backup cannot be
  replayed into sessions.
- OAuth `state` is HMAC-signed and expiring (10 minutes). Its nonce is also bound to a short-lived
  HttpOnly, SameSite=Lax cookie scoped to `/api/auth/github`, so a state minted for one browser
  cannot complete a callback in another (CSRF defense). Post-sign-in redirects are restricted to
  same-origin relative paths.
- Sessions live in the `Session` table with a 7-day sliding expiry, hashed IP metadata, and
  user-agent capture. Sign-out deletes the row and the cookie.
- Accounts are keyed by GitHub's immutable numeric user ID. A verified email can bind an unlinked
  legacy account once; an email already bound to a different GitHub ID is rejected, and mutable
  GitHub usernames are never used to merge accounts.

## Authorization (RBAC)

- Every page and API route resolves the acting organization server-side (`requireOrganization` /
  `requirePageOrganization`) and scopes every query by `organizationId`. Client-supplied
  org/repository/test IDs are always re-validated against that scope before use — a forged ID for
  another org is a 404, not a leak.
- **Roles:** `owner` > `admin` > `member` on `OrganizationMember`. Owner-sensitive changes lock the
  organization row, revalidate the acting membership, and commit the role change plus audit event in
  a serializable transaction. Members may read everything in their org but cannot mutate configuration (create/update/delete suites, monitors, repositories,
  baselines, or trigger runs). The check is centralized in `requireMutationRole` and enforced by
  every API route. In local mode the check is a no-op (single trusted operator).
- **Access provisioning:** users get memberships from pre-created rows, pending
  `OrganizationInvite` rows (consumed at sign-in), or — unless `AUTH_ALLOW_DEFAULT_ORG_SIGNUP=0` —
  auto-join the default organization. The first-member/owner decision runs in a serializable
  transaction with bounded retries, so concurrent first sign-ins cannot create two owners. With
  auto-join disabled and no
  invite, sign-in lands on an access-pending screen and exposes no data. From there users can
  **request access** (`POST /api/access-requests`, authenticated by session only): admins see the
  request on `/team` and approve (membership granted transactionally) or deny it. Requesters and
  denied users see their status on the sign-in screen; no dashboard data is exposed to them.
- Artifact bytes (screenshots, diffs, baselines) are never publicly readable: pages mint
  short-lived HMAC-signed URLs; `/api/artifacts/:id` verifies the token binds to the artifact id,
  organization and expiry, then queries the artifact within that organization.

## SSRF guard (visual suites & synthetic monitors)

Users configure arbitrary URLs, which workers then fetch/navigate — that is an SSRF surface, and it
is guarded in `src/lib/net/guard.ts`:

1. Scheme allowlist: http/https only.
2. Hostname blocklist: `localhost`, `*.local`, `*.internal`, `host.docker.internal`, cloud metadata
   hostnames.
3. DNS resolution + IP blocklist: loopback, RFC1918, CGNAT, link-local (169.254/16 — includes
   cloud metadata endpoints), benchmark and reserved ranges. IPv6 parsing covers compressed/
   expanded forms, IPv4-mapped and IPv4-compatible forms, ULA/link-local/site-local/multicast,
   6to4 and Teredo tunnels embedding private addresses, and NAT64 prefixes.
4. Every redirect target for synthetic `request` steps is revalidated before it is followed;
   cross-origin redirects drop `Authorization`, `Cookie` and `Proxy-Authorization` headers.
   Playwright HTTP subresources, redirects and WebSocket connections are routed through the same
   guard, and service workers are disabled in worker browser contexts.
5. `SENTINEL_ALLOW_PRIVATE_TARGETS=1` relaxes this **for local development only** (documented in
   `.env.example`).

**Known limitation — DNS rebinding:** the guard validates at URL-configuration/request time; the
subsequent fetch resolves DNS again, so an attacker controlling DNS could rebind between check and
fetch. The complete fix is a pinned-connection HTTP client and browser proxy. Documented as a
v1 boundary; production deployments should place workers in a network-isolated environment.

## Workers

- Separate OS processes (`src/workers/*`) with per-queue concurrency limits, 10-minute job locks,
  stalled-job detection, retries with exponential backoff, and graceful shutdown.
- Playwright contexts use fixed locale/timezone/reduced-motion; synthetic runs enforce a 20s step
  cap and 180s run deadline, abort the browser and close processes on every path. Service workers
  are disabled so subresource request routing cannot be bypassed.
- Separate artifact keys per organization keep storage logically partitioned; local-disk keys are
  resolved with an exact containment check, not a sibling-prefix `startsWith` check.

## Multi-tenancy status (honest)

The schema has been multi-tenant from day one (organizations, members, every domain row scoped by
org). **OAuth mode completes the deployment story:** users authenticate with GitHub, sessions are
stored server-side, and every query is scoped by membership.

GitHub App installations use a cryptographically bound, single-use state flow. An authenticated
administrator initiates the installation from the Repositories page (`GET /api/installations/initiate`),
which mints an HMAC-signed state nonce bound to the active organization ID, initiating user ID, and
expiration, and sets a short-lived HttpOnly SameSite=Lax cookie. When GitHub redirects back to the
setup callback (`GET /api/installations/callback`), SentinelPR validates the signature, browser cookie
nonce, expiration, and checks the installation's existence and ownership directly against the GitHub
App API. The installation is transactionally bound to the target organization, and repositories are
registered safely. Cross-tenant enumeration of unclaimed installations is completely eliminated; legacy
claim routes require verified single-use signed state and reject cross-tenant or guessed IDs (403/409).
A repository already owned by a different organization is a 409 conflict; registration never transfers
ownership. Webhook delivery ledgers are strictly scoped to repositories owned by the acting organization.

Residual boundaries to know about:

- In **local development** mode there is no authentication. Production rejects this configuration;
  keep local development bound to loopback and never expose it through a tunnel or reverse proxy.
- Roles are organization-global; per-resource ACLs (e.g. a member limited to one suite) are not
  implemented.
- Team management lives on the `/team` page (admin/owner only). **Invites:** admins may invite
  `member` and `admin`; only owners may assign `owner`; invites are consumed at sign-in **and**
  lazily on any subsequent authenticated request. **Role editing** (`PATCH /api/members/:id`) and
  **removal** (`DELETE`) enforce owner protection: another member cannot demote or remove an owner;
  to hand over ownership, promote a member to owner and self-demote. The last owner cannot demote or remove
  themselves. Members may self-demote (give up admin). Every change is audit-logged with the actor,
  before and after roles.
- **Application API limits:** authenticated requests are limited per user; anonymous requests use a
  conservative bucket unless the trusted proxy chain is explicitly configured. Redis-backed sliding
  windows are shared across production replicas; route-specific quotas protect OAuth, installations,
  manual review, visual/synthetic runs, access requests, and signed artifact downloads. Rejections use
  HTTP 429 with `Retry-After`. Gateway controls remain useful defense in depth.
- **Retention:** pruning is disabled unless `RETENTION_ENABLED=1`, with a non-mutating dry-run mode.
  Only aged terminal records and expired sessions are selected; queued/running work and every
  baseline/snapshot/step-referenced artifact are protected. Artifact metadata and a durable deletion
  intent commit atomically, then object removal retries with backoff. Audit logs are preserved
  indefinitely unless `RETENTION_AUDIT_LOG_DAYS` is explicitly set positive. See [retention.md](retention.md)
  and the validated settings in [configuration.md](configuration.md#database-and-artifact-retention).

## Prompt-injection stance

PR descriptions, repo content and AI outputs are treated as data, never as instructions. The AI
review prompt states this explicitly; AI findings are zod-validated, restricted to files that
actually appear in the diff, confidence-gated, and can never call GitHub APIs directly — only the
pipeline publishes, through thresholds and dedupe.
