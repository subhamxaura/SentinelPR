# Contributing to SentinelPR

Thanks for your interest in improving SentinelPR. This guide covers setup, where things live, and
the expectations for every pull request.

## Development setup

```bash
pnpm install
cp .env.example .env
docker compose up -d          # postgres + redis + minio
pnpm db:migrate
pnpm dev                      # http://localhost:3000
```

Workers run in separate terminals (`pnpm worker:review`, `worker:visual`, `worker:synthetic`).
Playwright browsers on first run: `pnpm exec playwright install chromium`.

> Windows note: local dev uses the embedded Postgres in `scripts/dev-postgres.ts` if Docker is
> unavailable. Builds use Turbopack by default; if your environment restricts symlink creation,
> `pnpm exec next build --webpack` is the fallback.

## Repository map

| Path | What lives there |
| --- | --- |
| `src/lib/rules/` | Deterministic review rules (pure, unit-tested) |
| `src/lib/risk/` | Unified risk engine (pure, unit-tested) |
| `src/lib/auth/` | OAuth client, session store, provisioning, mode resolution |
| `src/lib/web/` | Session context, role rules, API helpers, formatting |
| `src/lib/github/` | Octokit wrappers, webhook parsing/verification |
| `src/lib/net/guard.ts` | SSRF protection (pure, unit-tested) |
| `src/lib/visual/` `src/lib/synth/` | Playwright capture/diff and synthetic step executors |
| `src/app/api/` | Route handlers — every mutation is role-checked and audit-logged |
| `src/app/` | Dashboard pages (server components, dark theme) |
| `src/workers/` | BullMQ workers (review / visual / synthetic) |
| `prisma/` | Schema + migrations (Postgres) |
| `docs/` | Architecture, deployment, security, configuration |

## Ground rules

1. **Strict TypeScript.** No `any`, no non-null assertions to silence the compiler. `pnpm typecheck`
   must pass.
2. **Every metric is real.** No fake data, mock findings, or seeded history anywhere in the product.
   Empty states explain, they don't pretend.
3. **Never execute repository code.** Reviews read diffs via the GitHub API; Playwright only
   navigates configured URLs.
4. **Multi-tenancy is non-negotiable.** Every query is scoped by organization server-side. New
   domain models hang off `Organization`. Mutations go through role checks (`requireMutationRole`
   or the admin gate) and write to the audit log.
5. **Security changes must update `docs/security-model.md`** — the doc states both guarantees and
   honest limitations.

## Testing expectations

- Pure logic (rules, scoring, parsing, crypto) gets unit tests in a sibling `*.test.ts`.
  Run with `pnpm test`.
- Integration behavior is verified against docker compose services; CI runs typecheck → unit tests
  → migrations → build with real Postgres and Redis.
- UI changes: verify against a running dashboard; screenshots are welcome in the PR description.

## Pull request checklist

- [ ] `pnpm typecheck` passes
- [ ] `pnpm test` passes (add tests for new pure logic)
- [ ] `pnpm build` (or `--webpack`) succeeds
- [ ] New env vars are added to `.env.example` **and** `docs/configuration.md`
- [ ] Auth/security-relevant changes update `docs/security-model.md`
- [ ] No secrets in code, fixtures, or test output

## Commit style

Short imperative subject focused on intent ("Add last-owner guard to role changes"), body explaining
the why when it isn't obvious. Referencing issues helps reviewers connect context.
