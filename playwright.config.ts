import { defineConfig, devices } from "playwright/test";

const BASE_URL = "http://127.0.0.1:3100";

function requireLoopback(url: URL, label: string): void {
  if (!["localhost", "127.0.0.1", "::1", "[::1]"].includes(url.hostname)) {
    throw new Error(`${label} must point to a loopback host; E2E must not use a remote service.`);
  }
}

function requireE2EDatabase(): string {
  const raw = process.env.E2E_DATABASE_URL?.trim();
  if (!raw) throw new Error("E2E_DATABASE_URL is required; see docs/e2e-testing.md.");

  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("E2E_DATABASE_URL must be a valid PostgreSQL URL.");
  }
  if (!["postgres:", "postgresql:"].includes(url.protocol)) {
    throw new Error("E2E_DATABASE_URL must use the postgres or postgresql scheme.");
  }
  requireLoopback(url, "E2E_DATABASE_URL");
  const databaseName = decodeURIComponent(url.pathname.replace(/^\/+/, ""));
  if (!databaseName.toLowerCase().endsWith("_e2e")) {
    throw new Error("E2E_DATABASE_URL must name a dedicated database ending in _e2e.");
  }
  return raw;
}

function redisDatabase(url: URL): number {
  const path = url.pathname.replace(/^\/+/, "");
  if (!path) return 0;
  if (!/^\d+$/.test(path)) throw new Error("Redis URL path must be a numeric logical database index.");
  return Number(path);
}

function normalizeRedisHost(hostname: string): string {
  return ["localhost", "127.0.0.1", "::1", "[::1]"].includes(hostname) ? "loopback" : hostname.toLowerCase();
}

function requireE2ERedis(): string {
  const raw = process.env.E2E_REDIS_URL?.trim();
  if (!raw) throw new Error("E2E_REDIS_URL is required; use a non-default Redis logical DB (see docs/e2e-testing.md).");

  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("E2E_REDIS_URL must be a valid Redis URL.");
  }
  if (!["redis:", "rediss:"].includes(url.protocol)) {
    throw new Error("E2E_REDIS_URL must use the redis or rediss scheme.");
  }
  requireLoopback(url, "E2E_REDIS_URL");
  if (redisDatabase(url) === 0) {
    throw new Error("E2E_REDIS_URL must use a non-default logical database (index 1 or higher).");
  }

  const configuredRedis = process.env.REDIS_URL?.trim();
  if (configuredRedis) {
    const current = new URL(configuredRedis);
    const sameEndpoint =
      current.protocol === url.protocol &&
      normalizeRedisHost(current.hostname) === normalizeRedisHost(url.hostname) &&
      (current.port || (current.protocol === "rediss:" ? "6380" : "6379")) ===
        (url.port || (url.protocol === "rediss:" ? "6380" : "6379"));
    if (sameEndpoint && redisDatabase(current) === redisDatabase(url)) {
      throw new Error("E2E_REDIS_URL must not share the configured REDIS_URL logical database.");
    }
  }
  return raw;
}

const databaseUrl = requireE2EDatabase();
const redisUrl = requireE2ERedis();
process.env.PLAYWRIGHT_BASE_URL = BASE_URL;

const inheritedPlatformEnv: Record<string, string> = {};
for (const key of ["PATH", "Path", "SYSTEMROOT", "WINDIR", "TEMP", "TMP", "USERPROFILE", "HOMEDRIVE", "HOMEPATH", "PATHEXT", "ComSpec"]) {
  const value = process.env[key];
  if (value) inheritedPlatformEnv[key] = value;
}

const serverEnv: Record<string, string> = {
  ...inheritedPlatformEnv,
  DATABASE_URL: databaseUrl,
  REDIS_URL: redisUrl,
  DASHBOARD_URL: BASE_URL,
  SENTINEL_AUTH_MODE: "oauth",
  AUTH_GITHUB_CLIENT_ID: "e2e-client-id",
  AUTH_GITHUB_CLIENT_SECRET: "e2e-client-secret-not-valid",
  AUTH_STATE_SECRET: "e2e-only-auth-state-secret-not-for-production",
  RATE_LIMIT_SECRET: "e2e-only-rate-limit-secret-not-for-production",
  ARTIFACT_TOKEN_SECRET: "e2e-only-artifact-secret-not-for-production",
  GITHUB_WEBHOOK_SECRET: "e2e-only-webhook-secret-not-for-production",
  ARTIFACT_DRIVER: "local",
  ARTIFACT_LOCAL_DIR: ".data/e2e-artifacts",
  RETENTION_ENABLED: "0",
  NEXT_TELEMETRY_DISABLED: "1",
  SENTINELPR_E2E: "1",
};

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: true,
  forbidOnly: Boolean(process.env.CI),
  retries: 0,
  workers: process.env.CI ? 2 : undefined,
  reporter: process.env.CI ? [["github"], ["list"]] : "list",
  timeout: 45_000,
  expect: { timeout: 8_000 },
  outputDir: "./test-results",
  use: {
    ...devices["Desktop Chrome"],
    baseURL: BASE_URL,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    command: "pnpm exec next dev --webpack --hostname 127.0.0.1 --port 3100",
    url: BASE_URL,
    reuseExistingServer: false,
    timeout: 120_000,
    env: serverEnv,
  },
});
