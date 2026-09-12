# GitHub App setup

SentinelPR's primary integration is a real GitHub App: installation tokens, webhook-driven reviews,
check runs and inline review comments. A PAT (`GITHUB_TOKEN`) is a documented fallback for manual
runs before the App is configured.

## 1. Create the app

Go to <https://github.com/settings/apps/new> (or the organization equivalent):

**Basics**
- GitHub App name: e.g. `SentinelPR (your-org)`
- Homepage URL: your dashboard URL (e.g. `http://localhost:3000` for local tunnels)

**Webhook**
- Active: ✅
- Webhook URL: `https://<your-host>/api/github/webhook`
- Webhook secret: generate a strong random value → this is `GITHUB_WEBHOOK_SECRET`

**Permissions (minimum required)**

| Permission | Access | Why |
| --- | --- | --- |
| Contents | Read | PR file patches come from the pulls API; contents is needed for some diff paths |
| Pull requests | Read & write | Read PR metadata/files, create reviews with inline comments |
| Checks | Read & write | Create the SentinelPR check run on each head SHA |
| Metadata | Read-only | Mandatory |

Subscribe to events: **Pull request**, **Installation**, **Installation repositories**.

**Where can this app be installed?** Any account (or restrict to your org).

## 2. Configure credentials

After creation, GitHub shows the App ID and lets you generate a private key (`.pem`).

```bash
# .env
GITHUB_APP_ID=123456
GITHUB_APP_SLUG=sentinelpr-your-org     # shown in the app's public URL
GITHUB_WEBHOOK_SECRET=<the secret from step 1>
GITHUB_APP_PRIVATE_KEY="-----BEGIN RSA PRIVATE KEY-----\nMIIE...\n-----END RSA PRIVATE KEY-----"
```

The private key may be raw (with literal `\n` escapes) or **base64-encoded** — the loader accepts
both, which keeps multiline PEMs sane in process managers and CI secrets.

## 3. Install and verify

1. Visit `https://github.com/apps/<slug>/installations/new` (Settings → linked from /repositories).
2. Select repositories. The `installation` and `installation_repositories` webhooks create the
   `GithubInstallation` and `Repository` rows automatically.
3. Open a PR. The `pull_request.opened` webhook creates a queued review run; the review worker
   fetches the PR through an installation token, runs the rule engine (+AI if enabled), persists
   findings, computes unified risk, then publishes the check run and inline comments.

Verify in **Settings**: the webhook delivery ledger shows each delivery with status
`received/processed/failed`, deduplicated by GitHub's delivery id. Signature failures are rejected
with 401 before any processing.

## Local development without a public host

Use a tunnel (e.g. `gh webhook forward` / ngrok / cloudflared) and set `DASHBOARD_URL` to the
public URL so check-run links resolve. For pure local testing without the App, set
`GITHUB_TOKEN` and trigger reviews manually from **Repositories → Review PR** — the same pipeline
runs, with the PAT identity instead of installation tokens.

## What happens on events

| Event | Action |
| --- | --- |
| `pull_request.opened / synchronize / reopened / ready_for_review` | Create/update PR row, create review run (deduped per head SHA), enqueue review |
| `pull_request.closed / converted_to_draft / labeled / …` | Recorded, no review spent |
| `installation.created / deleted` | Register/soft-remove the installation |
| `installation_repositories.added / removed` | Register/deactivate repositories |
| anything else | Recorded in the ledger, acknowledged 202, no action |
