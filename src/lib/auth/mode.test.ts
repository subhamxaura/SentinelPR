import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { authMode } from "./mode";

const KEYS = ["SENTINEL_AUTH_MODE", "AUTH_GITHUB_CLIENT_ID", "AUTH_GITHUB_CLIENT_SECRET"] as const;

beforeEach(() => {
  for (const key of KEYS) delete process.env[key];
});

afterEach(() => {
  for (const key of KEYS) delete process.env[key];
});

describe("authMode", () => {
  it("defaults to local single-operator mode without credentials", () => {
    expect(authMode()).toBe("local");
  });

  it("auto-enables oauth when client credentials exist", () => {
    process.env.AUTH_GITHUB_CLIENT_ID = "cid";
    process.env.AUTH_GITHUB_CLIENT_SECRET = "secret";
    expect(authMode()).toBe("oauth");
  });

  it("respects explicit pins over auto-detection", () => {
    process.env.AUTH_GITHUB_CLIENT_ID = "cid";
    process.env.AUTH_GITHUB_CLIENT_SECRET = "secret";

    process.env.SENTINEL_AUTH_MODE = "local";
    expect(authMode()).toBe("local");

    process.env.SENTINEL_AUTH_MODE = "oauth";
    expect(authMode()).toBe("oauth");
  });
});
