import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it, vi } from "vitest";
import { closeRateLimitConnection, enforceRateLimit } from "./rate-limit";

const enabled = process.env.RUN_DB_INTEGRATION === "1";

describe.skipIf(!enabled)("Redis-backed API rate limiting", () => {
  afterAll(async () => {
    await closeRateLimitConnection();
    vi.unstubAllEnvs();
  });

  it("atomically rejects concurrent hits beyond the shared limit", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("REDIS_URL", process.env.REDIS_URL ?? "redis://127.0.0.1:6379");
    vi.stubEnv("RATE_LIMIT_SECRET", "integration-test-only-rate-limit-secret");

    const policy = { scope: `redis-integration-${randomUUID()}`, limit: 2, windowMs: 10_000 };
    const request = new Request("http://localhost/api/test", { method: "POST" });
    const results = await Promise.allSettled(
      Array.from({ length: 5 }, () => enforceRateLimit(request, policy, "integration-user")),
    );

    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(2);
    const rejected = results.filter((result): result is PromiseRejectedResult => result.status === "rejected");
    expect(rejected).toHaveLength(3);
    expect(rejected.every((result) => result.reason?.code === "API_RATE_LIMIT_EXCEEDED")).toBe(true);
  });
});
