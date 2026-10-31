import { createHash, randomBytes, randomUUID } from "node:crypto";
import { Pool } from "pg";
import { test as base } from "playwright/test";

export const E2E_WEBHOOK_SECRET = "e2e-only-webhook-secret-not-for-production";
export const SESSION_COOKIE_NAME = "sentinel_session";

export interface E2EFixture {
  pool: Pool;
  key: string;
  organizationId: string;
  organizationName: string;
  userId: string;
  email: string;
  githubLogin: string;
  sessionId: string;
  repositoryId: string;
  repositoryFullName: string;
  repositoryGithubId: number;
  installationId: number;
}

function requiredEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} must be configured through playwright.config.ts.`);
  return value;
}

function sessionHash(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export const test = base.extend<{ e2e: E2EFixture }>({
  e2e: async ({ page }, use, testInfo) => {
    const connectionString = requiredEnv("E2E_DATABASE_URL");
    const baseUrl = requiredEnv("PLAYWRIGHT_BASE_URL");
    const pool = new Pool({ connectionString, max: 2, connectionTimeoutMillis: 5_000 });

    const key = createHash("sha256")
      .update(`${process.pid}:${testInfo.workerIndex}:${testInfo.testId}`)
      .digest("hex")
      .slice(0, 16);
    const organizationId = randomUUID();
    const organizationName = `E2E Organization ${key}`;
    const organizationSlug = `e2e-${key}`;
    const userId = randomUUID();
    const email = `e2e-${key}@example.test`;
    const githubLogin = `e2e-${key}`;
    const memberId = randomUUID();
    const repositoryId = randomUUID();
    const repositoryGithubId = 1_000_000_000 + (Number.parseInt(key.slice(0, 8), 16) % 1_000_000_000);
    const repositoryOwner = `e2e-${key}`;
    const repositoryName = "fixture-repository";
    const repositoryFullName = `${repositoryOwner}/${repositoryName}`;
    const installationId = 1_000_000_000 + (Number.parseInt(key.slice(8, 16), 16) % 1_000_000_000);
    const sessionId = randomUUID();
    const sessionToken = randomBytes(32).toString("base64url");
    let organizationCreated = false;
    let userCreated = false;

    try {
      await pool.query(
        'INSERT INTO "Organization" ("id", "name", "slug", "updatedAt") VALUES ($1, $2, $3, NOW())',
        [organizationId, organizationName, organizationSlug],
      );
      organizationCreated = true;

      await pool.query(
        'INSERT INTO "User" ("id", "email", "name", "githubLogin") VALUES ($1, $2, $3, $4)',
        [userId, email, `E2E User ${key}`, githubLogin],
      );
      userCreated = true;

      await pool.query(
        'INSERT INTO "OrganizationMember" ("id", "organizationId", "userId", "role") VALUES ($1, $2, $3, $4)',
        [memberId, organizationId, userId, "owner"],
      );

      await pool.query(
        'INSERT INTO "Repository" ("id", "organizationId", "githubId", "owner", "name", "fullName", "private", "defaultBranch", "config", "active", "updatedAt") VALUES ($1, $2, $3, $4, $5, $6, false, $7, \'{}\'::jsonb, true, NOW())',
        [repositoryId, organizationId, repositoryGithubId, repositoryOwner, repositoryName, repositoryFullName, "main"],
      );

      await pool.query(
        'INSERT INTO "Session" ("id", "tokenHash", "userId", "activeOrgId", "expiresAt", "userAgent") VALUES ($1, $2, $3, $4, $5, $6)',
        [sessionId, sessionHash(sessionToken), userId, organizationId, new Date(Date.now() + 60 * 60 * 1000), "SentinelPR Playwright E2E"],
      );

      await page.context().addCookies([
        {
          name: SESSION_COOKIE_NAME,
          value: sessionToken,
          url: baseUrl,
          httpOnly: true,
          secure: false,
          sameSite: "Lax",
        },
      ]);

      await use({
        pool,
        key,
        organizationId,
        organizationName,
        userId,
        email,
        githubLogin,
        sessionId,
        repositoryId,
        repositoryFullName,
        repositoryGithubId,
        installationId,
      });
    } finally {
      await page.context().clearCookies().catch(() => undefined);
      let cleanupError: unknown;
      if (organizationCreated) {
        try {
          await pool.query('DELETE FROM "Organization" WHERE "id" = $1', [organizationId]);
        } catch (error) {
          cleanupError = error;
        }
      }
      if (userCreated) {
        try {
          await pool.query('DELETE FROM "User" WHERE "id" = $1', [userId]);
        } catch (error) {
          cleanupError ??= error;
        }
      }
      try {
        await pool.end();
      } catch (error) {
        cleanupError ??= error;
      }
      if (cleanupError) throw cleanupError;
    }
  },
});

export { expect } from "playwright/test";
