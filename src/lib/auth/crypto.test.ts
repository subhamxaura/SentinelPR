import { afterEach, describe, expect, it, vi } from "vitest";
import { env } from "@/lib/env";
import { createSignedState, sanitizeRedirect, sessionTokenHash, stateNonceMatches, verifySignedState } from "./crypto";

describe("sanitizeRedirect", () => {
  it("allows same-origin relative paths", () => {
    expect(sanitizeRedirect("/pull-requests/abc")).toBe("/pull-requests/abc");
    expect(sanitizeRedirect("/")).toBe("/");
    expect(sanitizeRedirect("/pull-requests/123?tab=files&page=2")).toBe(
      "/pull-requests/123?tab=files&page=2",
    );
  });

  it("preserves valid application-relative paths, query strings, and fragments", () => {
    expect(sanitizeRedirect("/safe/path?next=%5Cevil.example")).toBe(
      "/safe/path?next=%5Cevil.example",
    );
    expect(sanitizeRedirect("/safe/path?next=%5cevil.example")).toBe(
      "/safe/path?next=%5cevil.example",
    );
    expect(sanitizeRedirect("/safe/path#section")).toBe("/safe/path#section");
    expect(sanitizeRedirect("/safe/path?tab=files#diff-1")).toBe("/safe/path?tab=files#diff-1");
  });

  it("rejects protocol-relative and absolute URLs (open-redirect defense)", () => {
    expect(sanitizeRedirect("//evil.example")).toBe("/");
    expect(sanitizeRedirect("///evil.example")).toBe("/");
    expect(sanitizeRedirect("https://evil.example")).toBe("/");
    expect(sanitizeRedirect("http://evil.example/callback")).toBe("/");
    expect(sanitizeRedirect("javascript:alert(1)")).toBe("/");
    expect(sanitizeRedirect("data:text/html,evil")).toBe("/");
  });

  it("rejects literal backslashes and literal-backslash variants", () => {
    expect(sanitizeRedirect("/\\evil.example")).toBe("/");
    expect(sanitizeRedirect("/\\\\evil.example")).toBe("/");
    expect(sanitizeRedirect("/\\/evil.example")).toBe("/");
    expect(sanitizeRedirect("\\\\evil.example")).toBe("/");
    expect(sanitizeRedirect("/path\\with\\backslash")).toBe("/");
  });

  it("rejects percent-encoded backslashes in paths and double-encoded variants", () => {
    expect(sanitizeRedirect("/%5Cevil.example")).toBe("/");
    expect(sanitizeRedirect("/%5cevil.example")).toBe("/");
    expect(sanitizeRedirect("/%255Cevil.example")).toBe("/");
    expect(sanitizeRedirect("/%255cevil.example")).toBe("/");
    expect(sanitizeRedirect("/.%5Cevil.example")).toBe("/");
    expect(sanitizeRedirect("/%2f/evil.example")).toBe("/");
    expect(sanitizeRedirect("/%2Fevil.example")).toBe("/");
  });

  it("rejects control characters and malformed percent encodings", () => {
    expect(sanitizeRedirect("/\r\nLocation: https://evil.example")).toBe("/");
    expect(sanitizeRedirect("/\x00evil")).toBe("/");
    expect(sanitizeRedirect("/\x1fevil")).toBe("/");
    expect(sanitizeRedirect("/\x7fevil")).toBe("/");
    expect(sanitizeRedirect("/%00evil")).toBe("/");
    expect(sanitizeRedirect("/%99malformed")).toBe("/");
    expect(sanitizeRedirect("/%")).toBe("/");
    expect(sanitizeRedirect("/%2")).toBe("/");
    expect(sanitizeRedirect("/%ZZ")).toBe("/");
  });

  it("falls back to / for empty values", () => {
    expect(sanitizeRedirect(null)).toBe("/");
    expect(sanitizeRedirect(undefined)).toBe("/");
    expect(sanitizeRedirect("")).toBe("/");
  });
});

describe("session token hashing", () => {
  it("produces stable sha-256 digests", () => {
    expect(sessionTokenHash("token-a")).toBe(sessionTokenHash("token-a"));
    expect(sessionTokenHash("token-a")).not.toBe(sessionTokenHash("token-b"));
  });

  it("never stores the raw token", () => {
    const hash = sessionTokenHash("super-secret-cookie-value");
    expect(hash).not.toContain("super-secret");
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("signed OAuth state", () => {
  it("round-trips nonce and sanitized redirect", () => {
    const { state, nonce } = createSignedState("/visual");
    const verified = verifySignedState(state);
    expect(verified).not.toBeNull();
    expect(verified?.nonce).toBe(nonce);
    expect(verified?.redirectTo).toBe("/visual");
  });

  it("rejects tampered signatures", () => {
    const { state } = createSignedState("/");
    const [body] = state.split(".");
    expect(verifySignedState(`${body}.bogussignature`)).toBeNull();
    expect(verifySignedState(`${body}tampered.${"bogus"}`)).toBeNull();
  });

  it("rejects malformed state values", () => {
    expect(verifySignedState("")).toBeNull();
    expect(verifySignedState("no-signature")).toBeNull();
    expect(verifySignedState("a.b.c")).toBeNull();
  });
});

describe("OAuth state signing secret", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("fails closed in production when AUTH_STATE_SECRET is missing", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("AUTH_STATE_SECRET", "");
    vi.stubEnv("AUTH_SECRET", "");
    expect(() => createSignedState("/")).toThrow(/AUTH_STATE_SECRET/);
  });

  it("accepts AUTH_SECRET alias when AUTH_STATE_SECRET is missing in production", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("AUTH_STATE_SECRET", "");
    vi.stubEnv("AUTH_SECRET", "super-secret-auth-fallback");
    const { state } = createSignedState("/repos");
    const verified = verifySignedState(state);
    expect(verified?.redirectTo).toBe("/repos");
  });
});

describe("OAuth state cookie binding", () => {
  it("accepts only the nonce minted for the same state", () => {
    const first = createSignedState("/");
    const second = createSignedState("/");
    expect(stateNonceMatches(first.nonce, first.nonce)).toBe(true);
    expect(stateNonceMatches(first.nonce, second.nonce)).toBe(false);
  });

  it("rejects missing, empty, and length-mismatched cookie values", () => {
    const { nonce } = createSignedState("/");
    expect(stateNonceMatches(nonce, null)).toBe(false);
    expect(stateNonceMatches(nonce, undefined)).toBe(false);
    expect(stateNonceMatches(nonce, "")).toBe(false);
    expect(stateNonceMatches(nonce, `${nonce}x`)).toBe(false);
  });
});
