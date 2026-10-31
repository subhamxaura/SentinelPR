import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { env } from "@/lib/env";
import { err } from "@/lib/errors";
import { apiError } from "@/lib/web/api";
import { enforceRateLimit, evaluateSlidingWindow, rateLimitClientIdentity } from "./rate-limit";

describe("API rate limiting", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("uses positive integer environment settings for policy counts and windows", () => {
    vi.stubEnv("RATE_LIMIT_MANUAL_REVIEW_PER_WINDOW", "8");
    vi.stubEnv("RATE_LIMIT_EXPENSIVE_WINDOW_SECONDS", "900");

    expect(env.rateLimit.manualReviewPerWindow).toBe(8);
    expect(env.rateLimit.expensiveWindowSeconds).toBe(900);
  });

  it("rejects unsafe quota configuration instead of silently accepting it", () => {
    vi.stubEnv("RATE_LIMIT_READ_PER_MINUTE", "0");
    expect(() => env.rateLimit.readPerMinute).toThrow("RATE_LIMIT_READ_PER_MINUTE must be a positive integer");
  });

  it("enforces rolling windows and returns the expiry of the oldest active hit", () => {
    const first = evaluateSlidingWindow([], 1_000, 2, 10_000);
    const second = evaluateSlidingWindow(first.timestamps, 2_000, 2, 10_000);
    const rejected = evaluateSlidingWindow(second.timestamps, 3_000, 2, 10_000);

    expect(first.allowed).toBe(true);
    expect(second.remaining).toBe(0);
    expect(rejected).toMatchObject({ allowed: false, retryAfterMs: 8_000, remaining: 0 });
    expect(evaluateSlidingWindow(rejected.timestamps, 11_000, 2, 10_000).allowed).toBe(true);
  });

  it("selects the client address only behind the configured number of trusted proxy hops", () => {
    const request = new Request("http://localhost/api/test", {
      headers: { "x-forwarded-for": "198.51.100.9, 10.0.0.2, 10.0.0.3" },
    });

    expect(rateLimitClientIdentity(request, 0)).toBe("unattributed");
    expect(rateLimitClientIdentity(request, 1)).toBe("ip:10.0.0.2");
    expect(rateLimitClientIdentity(request, 2)).toBe("ip:198.51.100.9");
    expect(rateLimitClientIdentity(new Request("http://localhost", {
      headers: { "x-forwarded-for": "not-an-ip" },
    }), 1)).toBe("unattributed");
  });

  it("rejects over-limit requests with a retryable 429 and Retry-After header", async () => {
    const policy = { scope: `unit-${randomUUID()}`, limit: 1, windowMs: 60_000 };
    const request = new Request("http://localhost/api/test");
    await enforceRateLimit(request, policy, "user:unit-test");

    await expect(enforceRateLimit(request, policy, "user:unit-test")).rejects.toMatchObject({
      code: "API_RATE_LIMIT_EXCEEDED",
      status: 429,
      details: { scope: policy.scope, retryAfterSeconds: expect.any(Number) },
    });

    const response = apiError(err.apiRateLimit("unit-test", 17));
    expect(response.status).toBe(429);
    expect(response.headers.get("retry-after")).toBe("17");
    expect(await response.json()).toMatchObject({
      error: { code: "API_RATE_LIMIT_EXCEEDED", category: "rate_limit" },
    });
  });
});
