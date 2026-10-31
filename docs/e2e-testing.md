# Browser E2E testing

SentinelPR's Playwright suite exercises the browser-facing authentication and review path against a real local Next.js server, PostgreSQL, and Redis. Tests seed and remove their own user, organization, repository, and database-backed session. The signed webhook is sent to the local app; it does not call GitHub. The OAuth authorization navigation is intercepted in the browser, and a tampered callback state is rejected before any token exchange.

## Isolation requirements

The test runner refuses to start unless both isolation targets are explicit:

- `E2E_DATABASE_URL` must point to a loopback PostgreSQL host and a dedicated database whose name ends in `_e2e` (for example, `sentinelpr_e2e`). It never falls back to `DATABASE_URL`.
- `E2E_REDIS_URL` must point to loopback Redis and a non-default logical database (for example, database `/1`). If `REDIS_URL` points to that same endpoint/database, the runner refuses to start.

Do not run the suite against production, staging, or a database containing user data. The fixture uses scoped inserts and deletes only; it does not truncate tables or issue `FLUSHDB`. The E2E web server uses fake OAuth/webhook secrets and a separate `.next-e2e` build directory. It listens on `127.0.0.1:3100`, uses Next.js Webpack dev mode to keep its cache isolated, and does not reuse an existing process.

## Run locally (PowerShell)

1. Start local PostgreSQL and Redis. Create a separate empty PostgreSQL database named `sentinelpr_e2e`; ensure Redis database index 1 is reserved for this test suite.
2. Generate the Prisma client, then apply the migrations to only the E2E database:

   ```powershell
   pnpm db:generate
   $env:E2E_DATABASE_URL = 'postgresql://sentinel:sentinel@127.0.0.1:5432/sentinelpr_e2e?schema=public'
   $env:E2E_REDIS_URL = 'redis://127.0.0.1:6379/1'
   $previousDatabaseUrl = $env:DATABASE_URL
   try {
     $env:DATABASE_URL = $env:E2E_DATABASE_URL
     pnpm db:migrate
     if ($LASTEXITCODE -ne 0) { throw 'E2E database migration failed.' }
   } finally {
     if ($null -eq $previousDatabaseUrl) { Remove-Item Env:DATABASE_URL -ErrorAction SilentlyContinue }
     else { $env:DATABASE_URL = $previousDatabaseUrl }
   }
   ```

3. Install the Chromium browser once and run the suite:

   ```powershell
   pnpm test:e2e:install
   pnpm test:e2e
   ```

Use credentials appropriate for your local test services. Keep the E2E variables in the current shell only; do not commit them to `.env`. If your regular app already uses Redis logical database 1, reserve another unused nonzero index and set `E2E_REDIS_URL` accordingly.

## Coverage

The suite verifies that unauthenticated protected-page navigation reaches sign-in; the GitHub OAuth start redirect has the expected callback and an HttpOnly, same-site state cookie; tampered callback state is rejected without an external token exchange; a seeded OAuth session survives navigation/reload and is removed by the visible sign-out action; and a valid HMAC-signed `pull_request` webhook records delivery, persists a queued review/outbox, creates the deterministic BullMQ job, and renders the queued run on the PR page.

CI creates a fresh `sentinelpr_e2e` database on its disposable PostgreSQL service, migrates it, uses Redis logical DB 1, installs Chromium, and runs `pnpm test:e2e`. Test traces/screenshots are written under ignored `test-results/` and are retained only when relevant to a failure.
