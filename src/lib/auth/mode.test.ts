import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { authMode } from "./mode";

const KEYS = ["SENTINEL_AUTH_MODE", "AUTH_GITHUB_CLIENT_ID", "AUTH_GITHUB_CLIENT_SECRET", "NODE_ENV"] as const;

beforeEach(() => {
  for (const key of KEYS) delete process.env[key];
});

afterEach(() => {
  for (const key of KEYS) delete process.env[key];
  vi.unstubAllEnvs();
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

  it("fails closed in production when OAuth is not configured", () => {
    vi.stubEnv("NODE_ENV", "production");
    expect(() => authMode()).toThrow(/Production authentication requires GitHub OAuth credentials/);
  });

  it("does not allow an explicit local-mode pin in production", () => {
    vi.stubEnv("NODE_ENV", "production");
    process.env.AUTH_GITHUB_CLIENT_ID = "cid";
    process.env.AUTH_GITHUB_CLIENT_SECRET = "secret";
    process.env.SENTINEL_AUTH_MODE = "local";
    expect(() => authMode()).toThrow(/Unauthenticated local mode is development-only/);
  });

  it("uses OAuth in production when credentials are ready", () => {
    vi.stubEnv("NODE_ENV", "production");
    process.env.AUTH_GITHUB_CLIENT_ID = "cid";
    process.env.AUTH_GITHUB_CLIENT_SECRET = "secret";
    expect(authMode()).toBe("oauth");
  });
});
