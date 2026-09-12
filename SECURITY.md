# Security policy

SentinelPR is developer infrastructure that handles source-code diffs, secrets detection, and
GitHub credentials. Security issues are treated as critical.

## Reporting a vulnerability

**Please do not open a public GitHub issue for security reports.**

Use GitHub's private vulnerability reporting (Security tab → Report a vulnerability) on this
repository, or contact the maintainers directly. Include a description, reproduction steps, and the
affected component if you can. You will get an acknowledgement within a few days and a fix or
mitigation plan as soon as possible. Credit is given in release notes unless you prefer otherwise.

## Supported configuration

Only the latest `main` receives security fixes. Deployment modes differ in exposure:

| Mode | Exposure | Notes |
| --- | --- | --- |
| OAuth (`SENTINEL_AUTH_MODE=oauth`) | Multi-user, internet-ready | Sessions, roles, and RBAC enforced on every route |
| Local (default) | **Single-operator, localhost only** | No authentication at all — never expose publicly |

## Design guarantees

The full model lives in [docs/security-model.md](docs/security-model.md). Highlights:

- Repository code is never executed; review reads diffs via the GitHub API.
- Webhook payloads are HMAC-validated (constant-time) and deduplicated by delivery id.
- Session tokens are opaque, HttpOnly, and stored only as SHA-256 digests.
- Every query is org-scoped server-side; cross-org IDs are 404s, not leaks.
- Artifact bytes require short-lived signed URLs.
- SSRF guard blocks private/metadata targets for all user-supplied URLs (documented DNS-rebinding
  caveat; run workers in an isolated network).
- Secrets are redacted from logs; no secret reaches the client bundle.

## Hardening recommendations

- Deploy in OAuth mode with HTTPS; generate strong `AUTH_STATE_SECRET` and `ARTIFACT_TOKEN_SECRET`.
- Keep `SENTINEL_ALLOW_PRIVATE_TARGETS=0` in production.
- Restrict database/Redis ingress to the app and worker networks.
- Rotate the GitHub App private key and webhook secret periodically.
